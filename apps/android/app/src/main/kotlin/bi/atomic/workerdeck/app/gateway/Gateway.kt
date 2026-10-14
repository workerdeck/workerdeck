package bi.atomic.workerdeck.app.gateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import bi.atomic.workerdeck.core.ffi.apiBase
import bi.atomic.workerdeck.core.ffi.gatewayName
import bi.atomic.workerdeck.core.ffi.gatewayNames
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// `id` is minted at pairing and keys everything stored about this gateway (read marks), so it outlives a rename.
// `name` comes from the store, which names every gateway at once so two on one host stay apart.
class Gateway(val id: String, val baseUrl: String, val key: String, val name: String = gatewayName(baseUrl)) {
    val apiBase: String = apiBase(baseUrl)

    override fun equals(other: Any?) = other is Gateway && other.id == id && other.baseUrl == baseUrl && other.key == key && other.name == name

    override fun hashCode() = id.hashCode()

    override fun toString() = "Gateway($id, $baseUrl)"
}

// Every paired gateway, in pairing order. Each auth key is sealed with an AES key that never leaves the Android
// Keystore; prefs hold only the ciphertext. A single pairing from before multi-gateway is read as a one-item list.
class GatewayStore(context: Context) {
    private val prefs = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    fun load(): List<Gateway> {
        migrate()
        val raw = prefs.getString("gateways", null) ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        val opened = (0 until array.length()).mapNotNull { i ->
            val item = array.optJSONObject(i) ?: return@mapNotNull null
            val key = runCatching { open(item.getString("key")) }.getOrNull() ?: return@mapNotNull null
            Triple(item.getString("id"), item.getString("url"), key)
        }
        val names = gatewayNames(opened.map { it.second })
        return opened.mapIndexed { i, (id, url, key) -> Gateway(id, url, key, names[i]) }
    }

    // Pairing a gateway that is already paired replaces its key in place and keeps its id, so its read marks survive.
    fun add(baseUrl: String, key: String): Gateway {
        val items = stored()
        val same = items.indexOfFirst { apiBase(it.getString("url")) == apiBase(baseUrl) }
        val gateway = Gateway(if (same < 0) UUID.randomUUID().toString() else items[same].getString("id"), baseUrl, key)
        val fresh = entry(gateway.id, baseUrl, seal(key))
        write(if (same < 0) items + fresh else items.mapIndexed { i, item -> if (i == same) fresh else item })
        return gateway
    }

    fun remove(id: String) {
        write(stored().filter { it.getString("id") != id })
    }

    private fun stored(): List<JSONObject> {
        val array = prefs.getString("gateways", null)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return emptyList()
        return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }

    private fun write(items: List<JSONObject>) {
        prefs.edit().putString("gateways", JSONArray(items).toString()).apply()
    }

    private fun entry(id: String, url: String, sealed: String) = JSONObject().put("id", id).put("url", url).put("key", sealed)

    private fun migrate() {
        val url = prefs.getString("url", null) ?: return
        val sealed = prefs.getString("key", null)
        val id = prefs.getString("id", null) ?: UUID.randomUUID().toString()
        val items = if (sealed == null) stored() else stored() + entry(id, url, sealed)
        prefs.edit().remove("url").remove("key").remove("id").putString("gateways", JSONArray(items).toString()).apply()
    }

    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun seal(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val out = cipher.iv + cipher.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun open(sealed: String): String {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, raw, 0, IV_BYTES))
        return String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES))
    }

    private companion object {
        const val ALIAS = "workerdeck.gateway"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
