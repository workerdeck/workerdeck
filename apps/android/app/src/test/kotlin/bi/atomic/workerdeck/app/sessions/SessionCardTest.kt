package bi.atomic.workerdeck.app.sessions

import bi.atomic.workerdeck.core.ffi.SessionList
import bi.atomic.workerdeck.core.ffi.TeamLead
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionCardTest {
    private fun session(id: String, status: String, extra: String) =
        """{"id":"$id","status":"$status","cwd":"/work/app","createdAt":1000,"lastSeq":4,"pendingPermissionCount":0$extra}"""

    @Test
    fun aLeadsShownMembersShareItsCard() {
        val list = SessionList(null, null)
        val sessions = listOf(
            session("lead", "idle", ""","title":"Lead","agent":{"id":"L","name":"Lead","leads":true}"""),
            session("m", "running", ""","title":"Worker","agent":{"id":"M","name":"Worker","lead":"L"}"""),
            session("solo", "idle", ""","title":"Solo""""),
        )
        list.setHost("h1", "mac", true, """{"sessions":[${sessions.joinToString(",")}]}""")
        val units = cardUnits(list.groups(0.0).flatMap { it.rows })
        val shape = units.map { unit -> unit.lead.sessionId to unit.members.map { it.sessionId } }.toSet()
        assertEquals(setOf("lead" to listOf("m"), "solo" to emptyList()), shape)
        list.close()
    }

    @Test
    fun anAgentCardDrawsTheCoresBadgeAndStatusInTheVendorTones() {
        val list = SessionList(null, null)
        val sessions = listOf(
            session("codex", "idle", ""","engine":"codex","model":"gpt-6.1-sol","modelName":"GPT-6.1 Sol","agent":{"id":"C","name":"Cody"},"statusLabel":{"text":"Porting","setAt":1}"""),
            session("claude", "idle", ""","model":"claude-opus-5-5","title":"Fix the list","agent":{"id":"O","name":"Opal"}"""),
        )
        list.setHost("h1", "mac", true, """{"sessions":[${sessions.joinToString(",")}]}""")
        val rows = list.groups(0.0).flatMap { it.rows }.associateBy { it.sessionId }
        val tones = listTones(dark = false)
        val codex = rows.getValue("codex")
        assertEquals("S" to "6.1", codex.modelBadge?.let { it.letter to it.version })
        assertEquals("Porting", codex.cardStatus)
        assertEquals(tones.fg3, cardStatusColor(codex, tones))
        assertEquals(tones.openai, badgeColor(codex, tones))
        val claude = rows.getValue("claude")
        assertEquals("O" to "5.5", claude.modelBadge?.let { it.letter to it.version })
        assertEquals("Fix the list", claude.cardStatus)
        assertEquals(tones.fg4, cardStatusColor(claude, tones))
        assertEquals(tones.claude, badgeColor(claude, tones))
        list.close()
    }

    private val lead = TeamLead("lead", "L", "Lead", null)

    @Test
    fun aCardOverALeadItMayJoinJoinsIt() {
        assertEquals(CardDrop.Join(lead), cardDrop(member = false, insideOwnTeam = false, over = "lead", leads = listOf(lead)))
        assertEquals(CardDrop.None, cardDrop(member = false, insideOwnTeam = false, over = "other", leads = listOf(lead)))
    }

    @Test
    fun aMemberLetGoOutsideItsTeamLeavesIt() {
        assertEquals(CardDrop.Leave, cardDrop(member = true, insideOwnTeam = false, over = null, leads = emptyList()))
        assertEquals(CardDrop.None, cardDrop(member = true, insideOwnTeam = true, over = null, leads = emptyList()))
        assertEquals(CardDrop.None, cardDrop(member = false, insideOwnTeam = false, over = null, leads = emptyList()))
    }
}
