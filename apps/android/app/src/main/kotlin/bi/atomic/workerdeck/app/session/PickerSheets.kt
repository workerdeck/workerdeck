package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.app.ui.WdColors
import bi.atomic.workerdeck.core.ffi.Mode
import bi.atomic.workerdeck.core.ffi.ModePicker
import bi.atomic.workerdeck.core.ffi.ModelPicker
import bi.atomic.workerdeck.core.ffi.PickerRow
import kotlinx.coroutines.launch

enum class Picker { MODEL, MODE }

private class SheetRow(
    val title: String,
    val summary: String?,
    val selected: Boolean,
    val isDefault: Boolean,
    val icon: ImageVector? = null,
    val iconTint: Color? = null,
    val disabled: Boolean = false,
    val onClick: () -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickerSheet(
    picker: Picker,
    models: ModelPicker?,
    modes: ModePicker?,
    onModel: (String?) -> Unit,
    onEffort: (String?) -> Unit,
    onMode: (Mode) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = Wd.colors
    val state = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    fun choose(row: PickerRow, act: (String?) -> Unit): () -> Unit = {
        if (!row.selected) act(row.value)
        close()
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = colors.background) {
        Column(Modifier.navigationBarsPadding()) {
            val title = when (picker) {
                Picker.MODEL -> models?.title ?: "Select model"
                Picker.MODE -> "Select mode"
            }
            Header(title, close)
            Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                when (picker) {
                    Picker.MODEL -> {
                        val main = models?.main.orEmpty()
                        if (main.isEmpty()) Empty("This session hasn't reported its models yet.")
                        else Card(main.map { SheetRow(it.title, it.summary, it.selected, it.isDefault, onClick = choose(it, onModel)) })
                        models?.more?.takeIf { it.isNotEmpty() }?.let { more ->
                            Heading("More models")
                            Card(more.map { SheetRow(it.title, it.summary, it.selected, it.isDefault, onClick = choose(it, onModel)) })
                        }
                        models?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                            Heading("Effort")
                            Card(efforts.map { SheetRow(it.title, it.summary, it.selected, it.isDefault, onClick = choose(it, onEffort)) })
                        }
                    }
                    Picker.MODE -> {
                        val rows = modes?.rows.orEmpty()
                        if (rows.isEmpty()) Empty("This session hasn't reported its modes yet.")
                        else Card(
                            rows.map { row ->
                                SheetRow(
                                    row.title,
                                    row.summary,
                                    row.selected,
                                    row.isDefault,
                                    icon = modeIcon(row.mode),
                                    iconTint = modeIconTint(row.mode, colors),
                                    disabled = row.disabled,
                                    onClick = {
                                        if (!row.selected) onMode(row.mode)
                                        close()
                                    },
                                )
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(title: String, onClose: () -> Unit) {
    val colors = Wd.colors
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 14.dp)) {
        IconButton(
            onClick = onClose,
            modifier = Modifier.size(34.dp).background(colors.secondary.copy(alpha = 0.18f), CircleShape).align(Alignment.CenterStart),
        ) {
            Icon(Icons.Filled.Close, contentDescription = "Close", tint = colors.secondary, modifier = Modifier.size(16.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, color = colors.primary, modifier = Modifier.align(Alignment.Center))
    }
}

@Composable
private fun Heading(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = Wd.colors.secondary,
        modifier = Modifier.padding(start = 4.dp, top = 22.dp, bottom = 8.dp),
    )
}

@Composable
private fun Empty(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = Wd.colors.secondary, modifier = Modifier.padding(16.dp))
}

@Composable
private fun Card(rows: List<SheetRow>) {
    val colors = Wd.colors
    Column(Modifier.fillMaxWidth().background(colors.secondary.copy(alpha = 0.12f), RoundedCornerShape(18.dp))) {
        rows.forEachIndexed { index, row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = !row.disabled, onClick = row.onClick)
                    .alpha(if (row.disabled) 0.4f else 1f)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                row.icon?.let { Icon(it, contentDescription = null, tint = row.iconTint ?: colors.accent, modifier = Modifier.width(24.dp)) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(row.title, style = MaterialTheme.typography.bodyLarge, color = colors.primary)
                        if (row.isDefault) DefaultTag()
                    }
                    row.summary?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.secondary) }
                }
                if (row.selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = colors.accent, modifier = Modifier.size(18.dp))
            }
            if (index < rows.size - 1) {
                Spacer(
                    Modifier
                        .padding(start = if (row.icon == null) 16.dp else 54.dp)
                        .fillMaxWidth()
                        .height(0.5.dp)
                        .background(colors.separator),
                )
            }
        }
    }
}

@Composable
private fun DefaultTag() {
    val accent = Wd.colors.accent
    Text(
        "DEFAULT",
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        color = accent,
        modifier = Modifier.background(accent.copy(alpha = 0.15f), CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

private fun modeIcon(mode: Mode): ImageVector = when (mode) {
    Mode.DEFAULT -> Icons.Filled.Lock
    Mode.ACCEPT_EDITS -> Icons.Filled.Edit
    Mode.BYPASS_PERMISSIONS -> Icons.Filled.Warning
    Mode.PLAN -> Icons.AutoMirrored.Filled.List
    Mode.DONT_ASK -> Icons.Filled.CheckCircle
    Mode.AUTO -> Icons.Filled.PlayArrow
}

private fun modeIconTint(mode: Mode, colors: WdColors): Color = when (mode) {
    Mode.DEFAULT -> colors.primary
    Mode.ACCEPT_EDITS -> colors.purple
    Mode.PLAN -> colors.blue
    Mode.AUTO, Mode.DONT_ASK -> colors.orange
    Mode.BYPASS_PERMISSIONS -> colors.red
}
