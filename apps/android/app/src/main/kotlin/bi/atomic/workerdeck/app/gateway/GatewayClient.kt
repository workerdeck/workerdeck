package bi.atomic.workerdeck.app.gateway

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class GatewayException(message: String) : IOException(message)

// A wrong key or path falls through to the dashboard, which answers HTML (or 405), never JSON.
fun classifyAnswer(code: Int, contentType: String?): String? = when {
    code == 401 || code == 403 -> "The gateway refused the auth key"
    contentType?.startsWith("application/json") != true -> "Not a WorkerDeck gateway, or the auth key is wrong"
    code !in 200..299 -> "The gateway answered $code"
    else -> null
}

class GatewayClient(val gateway: Gateway) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    suspend fun sessions(): String = get("/sessions")

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val request = authed(Request.Builder().url(gateway.apiBase + path)).build()
        try {
            http.newCall(request).execute().use { response ->
                classifyAnswer(response.code, response.header("content-type"))?.let { throw GatewayException(it) }
                response.body?.string() ?: throw GatewayException("Empty answer")
            }
        } catch (error: IllegalArgumentException) {
            throw GatewayException("Invalid gateway address")
        }
    }

    fun socket(sessionId: String, afterSeq: Long, listener: WebSocketListener): WebSocket {
        val base = gateway.apiBase.replaceFirst("http", "ws")
        val url = "$base/sessions/${encode(sessionId)}/ws?afterSeq=$afterSeq&truncateResults=1&imageRefs=1"
        return http.newWebSocket(authed(Request.Builder().url(url)).build(), listener)
    }

    private fun authed(builder: Request.Builder): Request.Builder =
        if (gateway.key.isEmpty()) builder else builder.header("Authorization", "Bearer ${gateway.key}")

    private fun encode(part: String) = java.net.URLEncoder.encode(part, "UTF-8").replace("+", "%20")
}
