package bi.atomic.workerdeck.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

// Readers for the core's byte snapshots, layout per docs/NATIVE-CORE-SNAPSHOTS.md. Offsets the core gives in UTF-8
// bytes come back here in UTF-16 units, the ones a Kotlin String and an AnnotatedString index by.
const val SNAPSHOT_VERSION = 3

class SnapshotVersionException(found: Int) : IllegalStateException("snapshot version $found, this reader knows $SNAPSHOT_VERSION")

data class LayoutRow(val key: String, val height: Float, val gapAbove: Boolean, val prompt: Boolean, val recap: Boolean)

data class TranscriptLayout(val rows: List<LayoutRow>, val revealRow: Int?, val revealNonce: Long)

data class TextRun(val start: Int, val end: Int, val intent: Int)

data class LineImage(
    val toolUseId: String,
    val sourceSeq: Long,
    val partIndex: Long,
    val mediaType: String,
    val bytes: Long,
    val lines: Int,
    val name: String,
    val placeholder: String,
)

data class TranscriptLine(
    val tone: Int,
    val gutterTone: Int,
    val band: Int,
    val flags: Int,
    val indent: Int,
    val columns: Int,
    val gutter: String,
    val text: String,
    val runs: List<TextRun>,
    val elapsedSince: Double?,
    val image: LineImage?,
) {
    val bold get() = flags and 1 != 0
    val italic get() = flags and 2 != 0
    val nested get() = flags and 4 != 0
    val pulsing get() = flags and 8 != 0
    val inOpen get() = flags and 16 != 0
    val pressable get() = flags and 32 != 0
}

data class TranscriptLines(val startRow: Int, val rows: List<List<TranscriptLine>>)

data class TranscriptFrame(val layout: TranscriptLayout, val lines: TranscriptLines)

// Colour words: 0 the slot's default (theme foreground, or no fill), FOREGROUND / BACKGROUND the theme's own, RGB | rgb.
data class ShellRun(val fg: Int, val bg: Int, val style: Int, val columns: Int, val text: String) {
    val bold get() = style and 1 != 0
    val dim get() = style and 2 != 0
    val italic get() = style and 4 != 0
    val underline get() = style and 8 != 0
    val strikethrough get() = style and 32 != 0
    val hidden get() = style and 64 != 0

    companion object {
        const val FOREGROUND = 0x01000000
        const val RGB = 0x02000000
        const val BACKGROUND = 0x03000000
    }
}

data class ShellGrid(
    val revision: Long,
    val cols: Int,
    val rows: Int,
    val totalLines: Int,
    val cursorRow: Int,
    val cursorCol: Int,
    val flags: Int,
    val title: String,
    val statusText: String,
    val startLine: Int,
    val lines: List<List<ShellRun>>,
) {
    val cursorVisible get() = flags and 1 != 0
    val altScreen get() = flags and 2 != 0
    val canType get() = flags and 4 != 0
    val running get() = flags and 8 != 0
    val ended get() = flags and 16 != 0
}

object Snapshots {
    fun transcriptLayout(bytes: ByteArray): TranscriptLayout = Reader(bytes).run { version(); layout() }

    fun transcriptLines(bytes: ByteArray): TranscriptLines = Reader(bytes).run { version(); lines() }

    fun transcriptFrame(bytes: ByteArray): TranscriptFrame = Reader(bytes).run {
        version()
        val layout = layout()
        version()
        TranscriptFrame(layout, lines())
    }

    fun shellGrid(bytes: ByteArray): ShellGrid = Reader(bytes).run {
        version()
        val revision = buf.long
        val cols = u16()
        val rows = u16()
        val total = u32()
        val cursorRow = u16()
        val cursorCol = u16()
        val flags = u8()
        val title = str16()
        val status = str16()
        val start = u32()
        val count = u32()
        val lines = List(count) {
            List(u16()) { ShellRun(buf.int, buf.int, u8(), u16(), str32()) }
        }
        ShellGrid(revision, cols, rows, total, cursorRow, cursorCol, flags, title, status, start, lines)
    }
}

private class Reader(bytes: ByteArray) {
    val buf: ByteBuffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

    fun version() {
        val found = u8()
        if (found != SNAPSHOT_VERSION) throw SnapshotVersionException(found)
    }

    fun u8() = buf.get().toInt() and 0xff

    fun u16() = buf.short.toInt() and 0xffff

    fun u32(): Int {
        val value = buf.int.toLong() and 0xffffffffL
        require(value <= Int.MAX_VALUE) { "count $value does not fit an Int" }
        return value.toInt()
    }

    fun str16() = utf8(u16()).first

    fun str32() = utf8(u32()).first

    fun utf8(length: Int): Pair<String, ByteArray> {
        val raw = ByteArray(length)
        buf.get(raw)
        return String(raw, Charsets.UTF_8) to raw
    }

    fun layout(): TranscriptLayout {
        val rows = List(u32()) {
            val key = str16()
            val height = buf.float
            val flags = u8()
            LayoutRow(key, height, flags and 1 != 0, flags and 2 != 0, flags and 4 != 0)
        }
        val reveal = buf.int
        val nonce = buf.long
        return TranscriptLayout(rows, reveal.takeIf { it >= 0 }, nonce)
    }

    fun lines(): TranscriptLines {
        val start = u32()
        val rows = List(u32()) { List(u32()) { line() } }
        return TranscriptLines(start, rows)
    }

    private fun line(): TranscriptLine {
        val tone = u8()
        val gutterTone = u8()
        val band = u8()
        val flags = u8()
        val indent = u16()
        val columns = u16()
        val gutter = str16()
        val (text, raw) = utf8(u32())
        val units = Utf16Offsets(raw)
        val runs = List(u16()) {
            val byteStart = u32()
            val byteLen = u32()
            TextRun(units.at(byteStart), units.at(byteStart + byteLen), u8())
        }
        val elapsed = if (flags and 128 != 0) buf.double else null
        val image = if (flags and 64 != 0) LineImage(str16(), buf.long, buf.long, str16(), buf.long, u16(), str16(), str16()) else null
        return TranscriptLine(tone, gutterTone, band, flags, indent, columns, gutter, text, runs, elapsed, image)
    }
}

private class Utf16Offsets(private val utf8: ByteArray) {
    private var byte = 0
    private var unit = 0

    fun at(target: Int): Int {
        if (target < byte) {
            byte = 0
            unit = 0
        }
        val end = target.coerceAtMost(utf8.size)
        while (byte < end) {
            val lead = utf8[byte].toInt() and 0xff
            val width = when {
                lead < 0x80 -> 1
                lead < 0xe0 -> 2
                lead < 0xf0 -> 3
                else -> 4
            }
            byte += width
            unit += if (width == 4) 2 else 1
        }
        return unit
    }
}
