package bi.atomic.workerdeck.app.gateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import bi.atomic.workerdeck.core.ffi.apiBase
import bi.atomic.workerdeck.core.ffi.gatewayName
import java.util.UUID
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// `id` is minted at pairing and keys everything stored about this gateway (read marks), so it outlives a rename.
class Gateway(val id: String, val baseUrl: String, val key: String) {
    val name: String = gatewayName(baseUrl)
    val apiBase: String = apiBase(baseUrl)

    override fun equals(other: Any?) = other is Gateway && other.id == id && other.baseUrl == baseUrl && other.key == key

    override fun hashCode() = id.hashCode()

    override fun toString() = "Gateway($id, $baseUrl)"
}

// The auth key is sealed with an AES key that never leaves the Android Keystore; prefs hold only the ciphertext.
class GatewayStore(context: Context) {
    private val prefs = context.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    fun load(): Gateway? {
        val url = prefs.getString("url", null) ?: return null
        val sealed = prefs.getString("key", null) ?: return null
        val key = runCatching { open(sealed) }.getOrNull() ?: return null
        val id = prefs.getString("id", null) ?: mint().also { prefs.edit().putString("id", it).apply() }
        return Gateway(id, url, key)
    }

    fun save(baseUrl: String, key: String): Gateway {
        val id = mint()
        prefs.edit().putString("id", id).putString("url", baseUrl).putString("key", seal(key)).apply()
        return Gateway(id, baseUrl, key)
    }

    private fun mint() = UUID.randomUUID().toString()

    fun clear() {
        prefs.edit().clear().apply()
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
