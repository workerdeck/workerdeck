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
