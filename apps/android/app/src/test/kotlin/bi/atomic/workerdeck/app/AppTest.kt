package bi.atomic.workerdeck.app

import bi.atomic.workerdeck.app.gateway.classifyAnswer
import bi.atomic.workerdeck.app.gateway.gatewayName
import bi.atomic.workerdeck.app.gateway.normalizeBaseUrl
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.core.ffi.bandNames
import bi.atomic.workerdeck.core.ffi.toneNames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    @Test
    fun aBaseUrlGainsASchemeAndLosesItsApiSuffix() {
        assertEquals("http://mac.tail.ts.net:8787", normalizeBaseUrl(" mac.tail.ts.net:8787/ "))
        assertEquals("https://deck.example", normalizeBaseUrl("https://deck.example/v1"))
        assertEquals("mac", gatewayName("http://mac.tail.ts.net:8787"))
        assertEquals("10.0.2.2", gatewayName("http://10.0.2.2:8790"))
    }

    @Test
    fun onlyAJsonAnswerCountsAsAGateway() {
        assertNull(classifyAnswer(200, "application/json; charset=utf-8"))
        assertNotNull(classifyAnswer(200, "text/html"))
        assertNotNull(classifyAnswer(405, "text/html"))
        assertNotNull(classifyAnswer(401, "application/json"))
    }
}
