package bi.atomic.workerdeck.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.Until

// The app under test: `bi.atomic.workerdeck.bench`, installed beside the everyday app, paired only with the private
// gateway that `pnpm android dev` runs on :8790, reached through `adb reverse`. The journeys read; they never send.
val targetApp: String
    get() = InstrumentationRegistry.getArguments().getString("targetAppId")
        ?: error("targetAppId is missing: run through the baselineprofile Gradle tasks")

private const val WAIT_MS = 20_000L

// A fresh install opens on the pairing form, pre-filled for the private gateway; one Connect and it stays paired.
fun MacrobenchmarkScope.waitForSessions() {
    val deadline = System.currentTimeMillis() + WAIT_MS
    while (!device.hasObject(By.res("sessions")) && !device.hasObject(By.text("Connect")) && System.currentTimeMillis() < deadline) {
        Thread.sleep(100)
    }
    device.findObject(By.text("Connect"))?.let { connect ->
        connect.click()
        check(device.wait(Until.hasObject(By.res("sessions")), WAIT_MS)) { "no sessions list after pairing with 127.0.0.1:8790 (adb reverse tcp:8790 tcp:8790)" }
    }
    check(device.wait(Until.hasObject(By.res("session-row")), WAIT_MS)) { "the private gateway lists no sessions" }
}

fun MacrobenchmarkScope.openFirstSession() {
    device.findObject(By.res("session-row")).click()
    check(device.wait(Until.hasObject(By.res("transcript")), WAIT_MS)) { "the session opened no transcript" }
    device.waitForIdle()
}

fun MacrobenchmarkScope.flingTranscript(times: Int = 3) {
    val transcript = device.findObject(By.res("transcript"))
    transcript.setGestureMargin(device.displayWidth / 5)
    repeat(times) {
        transcript.fling(Direction.UP)
        device.waitForIdle()
    }
    repeat(times) {
        transcript.fling(Direction.DOWN)
        device.waitForIdle()
    }
}

fun MacrobenchmarkScope.flingSessions() {
    val list = device.findObject(By.res("sessions"))
    list.setGestureMargin(device.displayWidth / 5)
    list.fling(Direction.DOWN)
    device.waitForIdle()
    list.fling(Direction.UP)
    device.waitForIdle()
}
