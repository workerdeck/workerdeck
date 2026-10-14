package bi.atomic.workerdeck.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// `pnpm android profile` (rig up first) writes app/src/release/generated/baselineProfiles/; commit what it writes.
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = targetApp, includeInStartupProfile = true) {
        pressHome()
        startActivityAndWait()
        waitForSessions()
        flingSessions()
        openFirstSession()
        flingTranscript()
        device.pressBack()
    }
}
