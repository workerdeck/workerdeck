package bi.atomic.workerdeck.core

import bi.atomic.workerdeck.core.ffi.Effect
import bi.atomic.workerdeck.core.ffi.Session
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// One thread owns the Session (docs/NATIVE-CORE-SNAPSHOTS.md § Calling pattern). Socket callbacks land on any thread;
// frames that pile up while the session is busy cross in one `receivedBatch`, and `WakeAt` is served here, so a host
// only ever sees the effects it has to act on, on the session thread. After `close()` every entry point is a no-op:
// a socket callback that arrives late must never throw on the caller's thread.
class SessionWorker(
    private val session: Session,
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
    private val onEffects: (List<Effect>) -> Unit,
) : AutoCloseable {
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "wd-session").apply { isDaemon = true }
    }
    private val inbox = ConcurrentLinkedQueue<String>()
    private val drainQueued = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private var wake: ScheduledFuture<*>? = null

    fun received(frame: String) {
        if (closed.get()) return
        inbox.add(frame)
        if (drainQueued.compareAndSet(false, true)) post(::drain)
    }

    fun opened() = act { it.opened() }

    fun closed() = act { it.closed(clock()) }

    fun act(command: (Session) -> List<Effect>) = post { deliver(command(session)) }

    fun <T> read(query: (Session) -> T): Future<T> = executor.submit<T> { query(session) }

    // Commands already queued still run; the session is freed after them, on its own thread.
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        executor.execute {
            wake?.cancel(false)
            session.close()
        }
        executor.shutdown()
    }

    private fun post(task: () -> Unit) {
        if (closed.get()) return
        try {
            executor.execute(task)
        } catch (_: RejectedExecutionException) {
        }
    }

    private fun drain() {
        drainQueued.set(false)
        val batch = StringBuilder()
        while (true) {
            val frame = inbox.poll() ?: break
            if ('\n' in frame) {
                flush(batch)
                deliver(session.received(frame, clock()))
                continue
            }
            if (batch.isNotEmpty()) batch.append('\n')
            batch.append(frame)
        }
        flush(batch)
    }

    private fun flush(batch: StringBuilder) {
        if (batch.isEmpty()) return
        deliver(session.receivedBatch(batch.toString(), clock()))
        batch.setLength(0)
    }

    private fun deliver(effects: List<Effect>) {
        if (closed.get()) return
        val rest = effects.filter { effect ->
            if (effect is Effect.WakeAt) schedule(effect.at)
            effect !is Effect.WakeAt
        }
        if (rest.isNotEmpty()) onEffects(rest)
    }

    private fun schedule(at: Double) {
        wake?.cancel(false)
        val delay = ((at - clock()) * 1e6).toLong().coerceAtLeast(0)
        wake = executor.schedule({ if (!closed.get()) deliver(session.tick(clock())) }, delay, TimeUnit.MICROSECONDS)
    }
}
