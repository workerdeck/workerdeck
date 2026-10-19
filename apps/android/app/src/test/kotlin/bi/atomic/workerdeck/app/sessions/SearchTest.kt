package bi.atomic.workerdeck.app.sessions

import org.junit.Test
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

class SearchTest {
    @Test
    fun blankIsNotSearching() {
        assertFalse(searching(""))
        assertFalse(searching("   "))
    }

    @Test
    fun textIsSearching() {
        assertTrue(searching(" lead "))
    }
}
