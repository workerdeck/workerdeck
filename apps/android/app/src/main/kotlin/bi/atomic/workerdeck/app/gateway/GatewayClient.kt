package bi.atomic.workerdeck.app.gateway

import bi.atomic.workerdeck.core.ffi.classifyAnswer
import bi.atomic.workerdeck.core.ffi.socketUrl
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class GatewayException(message: String) : IOException(message)

// What a session view needs from the network: its socket and the REST calls the core asks for. Tests fake it.
interface Transport {
    fun socket(sessionId: String, afterSeq: Long, listener: WebSocketListener): WebSocket

    fun request(sessionId: String, method: String, path: String, scoped: Boolean, answer: (Int, String) -> Unit)
}

class GatewayClient(val gateway: Gateway) : Transport {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    suspend fun sessions(): String = get("/sessions")

    // An image under the API base with its `x-frame-durations` header; null when it did not come.
    suspend fun image(path: String): Pair<ByteArray, String?>? = withContext(Dispatchers.IO) {
        val request = runCatching { authed(Request.Builder().url(gateway.apiBase + path)).build() }.getOrNull() ?: return@withContext null
        runCatching {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) null else response.body?.bytes()?.let { it to response.header("x-frame-durations") }
            }
        }.getOrNull()
    }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val request = authed(Request.Builder().url(gateway.apiBase + path)).build()
        try {
            http.newCall(request).execute().use { response ->
                classifyAnswer(response.code.toUShort(), response.header("content-type"))?.let { throw GatewayException(it) }
                response.body?.string() ?: throw GatewayException("Empty answer")
            }
        } catch (error: IllegalArgumentException) {
            throw GatewayException("Invalid gateway address")
        }
    }

    // A core `Effect.Request`, answered with its status and body; 0 when no answer came.
    override fun request(sessionId: String, method: String, path: String, scoped: Boolean, answer: (Int, String) -> Unit) {
        val body = if (method == "GET") null else ByteArray(0).toRequestBody()
        val url = if (scoped) "${gateway.apiBase}/sessions/${encode(sessionId)}$path" else gateway.apiBase + path
        val request = runCatching { authed(Request.Builder().url(url)).method(method, body).build() }.getOrNull()
            ?: return answer(0, "")
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = answer(0, "")

            override fun onResponse(call: Call, response: Response) = response.use {
                answer(it.code, runCatching { it.body?.string() }.getOrNull() ?: "")
            }
        })
    }

    override fun socket(sessionId: String, afterSeq: Long, listener: WebSocketListener): WebSocket {
        val url = socketUrl(gateway.baseUrl, sessionId, afterSeq)
        return http.newWebSocket(authed(Request.Builder().url(url)).build(), listener)
    }

    private fun authed(builder: Request.Builder): Request.Builder =
        if (gateway.key.isEmpty()) builder else builder.header("Authorization", "Bearer ${gateway.key}")

    private fun encode(part: String) = java.net.URLEncoder.encode(part, "UTF-8").replace("+", "%20")
}
