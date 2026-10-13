package bi.atomic.workerdeck.core

import bi.atomic.workerdeck.core.ffi.Effect
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionWorkerTest {
    @Test
    fun framesThatPileUpCrossTogetherAndEffectsArriveOnTheSessionThread() {
        val threads = CopyOnWriteArrayList<String>()
        val effects = CopyOnWriteArrayList<Effect>()
        val worker = SessionWorker(Fixtures.session()) { batch ->
            threads.add(Thread.currentThread().name)
            effects.addAll(batch)
        }
        worker.received(Fixtures.ATTACHED)
        (1..200).forEach { worker.received(Fixtures.user(it, "message $it")) }
        val rows = worker.read { Snapshots.transcriptLayout(it.transcriptLayout()).rows.size }.get(5, TimeUnit.SECONDS)
        assertEquals(200, rows)
        assertTrue(threads.all { it == "wd-session" })
        assertTrue(effects.any { it is Effect.Changed && it.changed.transcript })
        assertTrue(effects.none { it is Effect.WakeAt })
        worker.close()
    }

    @Test
    fun commandsRunAfterTheFramesThatArrivedBeforeThem() {
        val sent = CopyOnWriteArrayList<String>()
        val worker = SessionWorker(Fixtures.session()) { batch ->
            batch.filterIsInstance<Effect.Send>().forEach { sent.add(it.text) }
        }
        worker.received(Fixtures.ATTACHED)
        worker.act { it.send("hello", emptyList()) }
        worker.read { }.get(5, TimeUnit.SECONDS)
        assertTrue(sent.toString(), sent.any { "hello" in it })
        worker.close()
    }

    @Test
    fun aCallbackAfterCloseIsANoOpAndNeverThrows() {
        val effects = CopyOnWriteArrayList<Effect>()
        val worker = SessionWorker(Fixtures.session()) { effects.addAll(it) }
        worker.received(Fixtures.ATTACHED)
        worker.close()
        worker.received(Fixtures.user(1, "late"))
        worker.opened()
        worker.closed()
        worker.act { it.send("late", emptyList()) }
        worker.close()
        assertTrue(effects.none { it is Effect.Send })
    }
}
