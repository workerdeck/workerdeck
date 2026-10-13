package bi.atomic.workerdeck.app.ui

import androidx.compose.ui.graphics.Color
import bi.atomic.workerdeck.core.ffi.bandNames
import bi.atomic.workerdeck.core.ffi.toneNames

// Colors from packages/ui/src/styles/terminal.css. Lines carry tone and band as bytes; the core names them, so the
// tables below key on the name and the byte order is never written down twice.
class Palette(val background: Color, val fg: Color, private val tones: List<Color>, private val bands: List<Color>) {
    fun tone(index: Int): Color = tones.getOrElse(index) { fg }

    fun band(index: Int): Color = bands.getOrElse(index) { Color.Transparent }

    companion object {
        val darkTones = mapOf(
            "fg" to Color(0xFFD4D4D4), "bright" to Color(0xFFFFFFFF), "dim" to Color(0xFF8A8A8A),
            "faint" to Color(0xFF6A6A6A), "mark" to Color(0xFFD97757), "blue" to Color(0xFFAFB9FE),
            "green" to Color(0xFF4EC9A0), "red" to Color(0xFFF14C4C), "yellow" to Color(0xFFD7BA7D),
            "magenta" to Color(0xFFC586C0), "peer" to Color(0xFF56D4DD), "diffAdd" to Color(0xFFB5E8A9),
            "diffRemove" to Color(0xFFF0A6A6), "diffContext" to Color(0xFF9A9A9A), "diffNumber" to Color(0xFF5A5A5A),
        )
        val lightTones = mapOf(
            "fg" to Color(0xFF2F2F2F), "bright" to Color(0xFF000000), "dim" to Color(0xFF6B6B6B),
            "faint" to Color(0xFF8D8D8D), "mark" to Color(0xFFBF5B3D), "blue" to Color(0xFF0A66C2),
            "green" to Color(0xFF16794A), "red" to Color(0xFFC62828), "yellow" to Color(0xFF8A6D00),
            "magenta" to Color(0xFF8B3A8B), "peer" to Color(0xFF0E7490), "diffAdd" to Color(0xFF12492A),
            "diffRemove" to Color(0xFF7A1F24), "diffContext" to Color(0xFF4A4A4A), "diffNumber" to Color(0xFF9A9A9A),
        )
        val darkBands = mapOf(
            "none" to Color.Transparent, "user" to Color.White.copy(alpha = 0.05f),
            "output" to Color.White.copy(alpha = 0.04f), "diffAdd" to Color(0xFF16301A), "diffRemove" to Color(0xFF3A1518),
        )
        val lightBands = mapOf(
            "none" to Color.Transparent, "user" to Color.Black.copy(alpha = 0.05f),
            "output" to Color.Black.copy(alpha = 0.04f), "diffAdd" to Color(0xFFE2F6E5), "diffRemove" to Color(0xFFFBE6E7),
        )

        fun of(dark: Boolean, tones: List<String> = toneNames(), bands: List<String> = bandNames()): Palette {
            val toneMap = if (dark) darkTones else lightTones
            val bandMap = if (dark) darkBands else lightBands
            val fg = toneMap.getValue("fg")
            return Palette(
                background = if (dark) Color(0xFF1E1E1E) else Color.White,
                fg = fg,
                tones = tones.map { toneMap[it] ?: fg },
                bands = bands.map { bandMap[it] ?: Color.Transparent },
            )
        }
    }
}
