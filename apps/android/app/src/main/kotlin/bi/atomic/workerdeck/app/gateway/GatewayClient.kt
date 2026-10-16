package bi.atomic.workerdeck.app.gateway

import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.killShellCall
import bi.atomic.workerdeck.core.ffi.listSessionsCall
import bi.atomic.workerdeck.core.ffi.restError
import bi.atomic.workerdeck.core.ffi.sessionRequestCall
import bi.atomic.workerdeck.core.ffi.sleepSessionCall
import bi.atomic.workerdeck.core.ffi.socketUrl
import bi.atomic.workerdeck.core.ffi.stopTaskCall
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
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

    suspend fun sessions(): String = perform(listSessionsCall())

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
        perform(sleepSessionCall(sessionId))
    }

    suspend fun stopTask(sessionId: String, toolUseId: String) {
        perform(stopTaskCall(sessionId, toolUseId))
    }

    suspend fun killShell(sessionId: String, shellId: String) {
        perform(killShellCall(sessionId, shellId))
    }

    // A call the core named, answered with JSON; any other answer throws as the core reads it.
    suspend fun perform(call: HttpCall): String = withContext(Dispatchers.IO) {
        val request = try {
            authed(Request.Builder().url(gateway.apiBase + call.path)).method(call.method, body(call)).build()
        } catch (error: IllegalArgumentException) {
            throw GatewayException("Invalid gateway address")
        }
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            restError(response.code.toUShort(), response.header("content-type"), text)?.let { throw GatewayException(it.message) }
            text
        }
    }

    private fun body(call: HttpCall) =
        call.body?.toRequestBody(JSON) ?: if (call.method == "GET") null else ByteArray(0).toRequestBody()

    // A core `Effect.Request`, answered with its status and body; 0 when no answer came.
    override fun request(sessionId: String, method: String, path: String, scoped: Boolean, answer: (Int, String) -> Unit) {
        val call = sessionRequestCall(sessionId, method, path, scoped)
        val request = runCatching { authed(Request.Builder().url(gateway.apiBase + call.path)).method(method, body(call)).build() }.getOrNull()
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

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
