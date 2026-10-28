package bi.atomic.workerdeck.app.gateway

import bi.atomic.workerdeck.core.ffi.HttpAnswer
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.generationHeader
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
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class GatewayException(message: String) : IOException(message)

// What a session view needs from the network: its socket and the REST calls the core asks for. Tests fake it.
interface Transport {
    // `conversation` opens a past conversation's read-only socket; null attaches the current one.
    fun socket(sessionId: String, afterSeq: Long, conversation: Long?, listener: WebSocketListener): WebSocket

    fun request(sessionId: String, method: String, path: String, scoped: Boolean, generation: Long?, answer: (Int, String) -> Unit)

    // Raw bytes under the API base, `null` on any failure: tool-result pictures.
    suspend fun bytes(path: String): ByteArray?

    // A call the core named, answered whatever the status; status 0 when no answer came.
    suspend fun answer(call: HttpCall): HttpAnswer

    // `bytes` as the body of `call` under `mediaType`, answered like `answer`.
    suspend fun upload(call: HttpCall, mediaType: String, bytes: ByteArray): HttpAnswer
}

class GatewayClient(val gateway: Gateway) : Transport {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    suspend fun sessions(): String = perform(listSessionsCall())

    override suspend fun bytes(path: String): ByteArray? = withContext(Dispatchers.IO) {
        val request = runCatching { authed(Request.Builder().url(gateway.apiBase + path)).build() }.getOrNull() ?: return@withContext null
        runCatching {
            http.newCall(request).execute().use { response -> if (!response.isSuccessful) null else response.body?.bytes() }
        }.getOrNull()
    }

    // `POST /sessions/:id/sleep`: the engine stops and wakes on the next message.
    suspend fun sleep(sessionId: String, generation: Long) {
        perform(sleepSessionCall(sessionId, generation))
    }

    suspend fun stopTask(sessionId: String, toolUseId: String, generation: Long) {
        perform(stopTaskCall(sessionId, toolUseId, generation))
    }

    suspend fun killShell(sessionId: String, shellId: String, generation: Long) {
        perform(killShellCall(sessionId, shellId, generation))
    }

    // A call the core named, answered with JSON; any other answer throws as the core reads it.
    suspend fun perform(call: HttpCall): String = withContext(Dispatchers.IO) {
        val request = try {
            authed(Request.Builder().url(gateway.apiBase + call.path), call.generation).method(call.method, body(call)).build()
        } catch (error: IllegalArgumentException) {
            throw GatewayException("Invalid gateway address")
        }
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            restError(response.code.toUShort(), response.header("content-type"), text)?.let { throw GatewayException(it.message) }
            text
        }
    }

    override suspend fun answer(call: HttpCall): HttpAnswer = exchange(call, body(call))

    override suspend fun upload(call: HttpCall, mediaType: String, bytes: ByteArray): HttpAnswer =
        exchange(call, bytes.toRequestBody(mediaType.toMediaTypeOrNull()))

    private suspend fun exchange(call: HttpCall, body: RequestBody?): HttpAnswer = withContext(Dispatchers.IO) {
        runCatching {
            val request = authed(Request.Builder().url(gateway.apiBase + call.path), call.generation).method(call.method, body).build()
            http.newCall(request).execute().use { response ->
                HttpAnswer(response.code.toUShort(), response.header("content-type"), response.body?.string().orEmpty())
            }
        }.getOrElse { HttpAnswer(0u, null, "") }
    }

    private fun body(call: HttpCall) =
        call.body?.toRequestBody(JSON) ?: if (call.method == "GET") null else ByteArray(0).toRequestBody()

    // A core `Effect.Request`, answered with its status and body; 0 when no answer came.
    override fun request(sessionId: String, method: String, path: String, scoped: Boolean, generation: Long?, answer: (Int, String) -> Unit) {
        val call = sessionRequestCall(sessionId, method, path, scoped, generation)
        val request = runCatching { authed(Request.Builder().url(gateway.apiBase + call.path), call.generation).method(method, body(call)).build() }.getOrNull()
            ?: return answer(0, "")
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = answer(0, "")

            override fun onResponse(call: Call, response: Response) = response.use {
                answer(it.code, runCatching { it.body?.string() }.getOrNull() ?: "")
            }
        })
    }

    override fun socket(sessionId: String, afterSeq: Long, conversation: Long?, listener: WebSocketListener): WebSocket {
        val url = socketUrl(gateway.baseUrl, sessionId, afterSeq, conversation)
        return http.newWebSocket(authed(Request.Builder().url(url)).build(), listener)
    }

    // A mutating call names the conversation it was written for; the gateway refuses it once the session moved on.
    private fun authed(builder: Request.Builder, generation: Long? = null): Request.Builder {
        generation?.let { builder.header(generationHeader(), it.toString()) }
        return if (gateway.key.isEmpty()) builder else builder.header("Authorization", "Bearer ${gateway.key}")
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
