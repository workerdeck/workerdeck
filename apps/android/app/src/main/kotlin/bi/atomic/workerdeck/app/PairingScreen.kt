package bi.atomic.workerdeck.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.BuildConfig
import kotlinx.coroutines.launch

// `onPair` probes the gateway and answers an error to show, or null once the pairing is saved.
@Composable
fun PairingScreen(onPair: suspend (url: String, key: String) -> String?) {
    var url by rememberSaveable { mutableStateOf(BuildConfig.DEV_GATEWAY_URL) }
    var key by rememberSaveable { mutableStateOf(BuildConfig.DEV_GATEWAY_KEY) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Connect a gateway", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            url,
            { url = it },
            label = { Text("Gateway URL") },
            placeholder = { Text("http://host:8787") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            key,
            { key = it },
            label = { Text("Auth key") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = url.isNotBlank() && !busy,
            onClick = {
                busy = true
                scope.launch {
                    error = onPair(url.trim(), key.trim())
                    busy = false
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Connecting…" else "Connect") }
    }
}
