package bi.atomic.workerdeck.app

import bi.atomic.workerdeck.app.gateway.Gateway
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.core.ffi.bandNames
import bi.atomic.workerdeck.core.ffi.toneNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppTest {
    @Test
    fun everyToneAndBandTheCoreNamesHasAColorInBothThemes() {
        val tones = toneNames()
        val bands = bandNames()
        assertTrue(tones.isNotEmpty() && bands.isNotEmpty())
        for (map in listOf(Palette.darkTones, Palette.lightTones)) assertEquals(emptyList<String>(), tones - map.keys)
        for (map in listOf(Palette.darkBands, Palette.lightBands)) assertEquals(emptyList<String>(), bands - map.keys)
    }

    // The URL rules themselves are tested in the core (`vm::gateway`); this pins the binding and the key's privacy.
    @Test
    fun aGatewayReadsItsRulesFromTheCoreAndNeverPrintsItsKey() {
        val gateway = Gateway("id", " mac.tail.ts.net:8787/v1 ", "secretkey")
        assertEquals("mac", gateway.name)
        assertEquals("http://mac.tail.ts.net:8787/v1", gateway.apiBase)
        assertFalse("secretkey" in gateway.toString())
    }
}
