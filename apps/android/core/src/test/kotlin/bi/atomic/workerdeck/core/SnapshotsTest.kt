package bi.atomic.workerdeck.core

import bi.atomic.workerdeck.core.ffi.snapshotVersion
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotsTest {
    @Test
    fun readsTheVersionTheCoreWrites() {
        assertEquals(SNAPSHOT_VERSION, snapshotVersion().toInt())
    }

    @Test
    fun decodesATranscriptFrameEndToEnd() {
        val session = Fixtures.session()
        session.receivedBatch(
            listOf(Fixtures.ATTACHED, Fixtures.user(1, "hi there"), Fixtures.assistant(2, "some **bold** reply")).joinToString("\n"),
            0.0,
        )
        val layout = session.transcriptLayout()
        val rows = Snapshots.transcriptLayout(layout).rows
        assertTrue(rows.size >= 2)
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
        assertTrue(rows.all { it.height > 0f })

        val frame = Snapshots.transcriptFrame(session.transcriptFrame(0u, rows.size.toUInt()))
        assertEquals(rows, frame.layout.rows)
        assertEquals(0, frame.lines.startRow)
        assertEquals(rows.size, frame.lines.rows.size)
        val text = frame.lines.rows.flatten().joinToString("\n") { it.text }
        assertTrue(text, "hi there" in text)
        val bold = frame.lines.rows.flatten().first { "reply" in it.text }
        assertTrue(bold.runs.any { bold.text.substring(it.start, it.end) == "bold" })

        assertEquals(frame.lines, Snapshots.transcriptLines(session.transcriptLines(0u, rows.size.toUInt())))
        session.close()
    }

    @Test
    fun decodesAShellGrid() {
        val session = Fixtures.session()
        session.received(Fixtures.ATTACHED, 0.0)
        session.openShell("sh_1", null, 20u, 4u)
        session.received(Fixtures.SHELL_ATTACHED, 0.0)
        val grid = Snapshots.shellGrid(session.shellGrid("sh_1", 0u, 100u)!!)
        assertEquals(listOf(20, 4, 4), listOf(grid.cols, grid.rows, grid.totalLines))
        assertEquals(listOf(1, 5), listOf(grid.cursorRow, grid.cursorCol))
        assertTrue(grid.cursorVisible && grid.canType && grid.running)
        assertEquals("#2 bash" to "running", grid.title to grid.statusText)
        assertEquals(listOf("hello", "world", "", ""), grid.lines.map { line -> line.joinToString("") { it.text }.trimEnd() })
        session.close()
    }

    @Test
    fun mapsRunOffsetsFromUtf8BytesToUtf16Units() {
        val text = "é🎉 ok"
        val raw = text.toByteArray()
        val ok = raw.size - 2
        val bytes = buffer {
            put(1); putInt(3); putInt(1); putInt(1)
            put(0); put(0); put(0); put(0); putShort(0); putShort(5)
            putShort(0)
            putInt(raw.size); put(raw)
            putShort(2)
            putInt(2); putInt(4); put(7)
            putInt(ok); putInt(2); put(9)
        }
        val line = Snapshots.transcriptLines(bytes).rows.single().single()
        assertEquals(3, Snapshots.transcriptLines(bytes).startRow)
        assertEquals(listOf("🎉", "ok"), line.runs.map { text.substring(it.start, it.end) })
        assertEquals(listOf(7, 9), line.runs.map { it.intent })
        assertNull(line.image)
        assertNull(line.elapsedSince)
    }

    @Test
    fun refusesAnotherVersion() {
        assertThrows(SnapshotVersionException::class.java) { Snapshots.transcriptLayout(byteArrayOf(2, 0, 0, 0, 0)) }
    }

    private fun buffer(fill: ByteBuffer.() -> Unit): ByteArray {
        val buf = ByteBuffer.allocate(256).order(ByteOrder.LITTLE_ENDIAN)
        buf.fill()
        return buf.array().copyOf(buf.position())
    }

    private fun ByteBuffer.put(value: Int) = put(value.toByte())
}
