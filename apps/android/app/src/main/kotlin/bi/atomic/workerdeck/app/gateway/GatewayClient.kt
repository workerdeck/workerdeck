package bi.atomic.workerdeck.app.gateway

import bi.atomic.workerdeck.core.ffi.answerError
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

    // Raw bytes under the API base, `null` on any failure: tool-result pictures.
    suspend fun bytes(path: String): ByteArray?
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

    override suspend fun bytes(path: String): ByteArray? = image(path)?.first

    // `POST /sessions/:id/sleep`: the engine stops and wakes on the next message.
    suspend fun sleep(sessionId: String) {
        call("/sessions/${encode(sessionId)}/sleep", "POST")
    }

    suspend fun stopTask(sessionId: String, toolUseId: String) {
        call("/sessions/${encode(sessionId)}/tasks/${encode(toolUseId)}/stop", "POST")
    }

    suspend fun killShell(sessionId: String, shellId: String) {
        call("/sessions/${encode(sessionId)}/shells/${encode(shellId)}/kill", "POST")
    }

    private suspend fun get(path: String): String = call(path, "GET")

    private suspend fun call(path: String, method: String): String = withContext(Dispatchers.IO) {
        val body = if (method == "GET") null else ByteArray(0).toRequestBody()
        val request = try {
            authed(Request.Builder().url(gateway.apiBase + path)).method(method, body).build()
        } catch (error: IllegalArgumentException) {
            throw GatewayException("Invalid gateway address")
        }
        http.newCall(request).execute().use { response ->
            val text = response.body?.string()
            answerError(response.code.toUShort(), response.header("content-type"), text.orEmpty())?.let { throw GatewayException(it) }
            text ?: throw GatewayException("Empty answer")
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
