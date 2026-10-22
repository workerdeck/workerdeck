package bi.atomic.workerdeck.core

import bi.atomic.workerdeck.core.ffi.Metrics
import bi.atomic.workerdeck.core.ffi.Session

object Fixtures {
    const val ATTACHED =
        """{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"conversation":1,"pendingPermissionCount":0}}"""

    fun user(seq: Int, text: String) =
        """{"type":"event","event":{"type":"user_message","message":{"role":"user","content":"$text"},"parentToolUseId":null,"uuid":"u$seq","seq":$seq,"ts":1}}"""

    fun assistant(seq: Int, text: String) =
        """{"type":"event","event":{"type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"$text"}]},"parentToolUseId":null,"uuid":"a$seq","seq":$seq,"ts":1}}"""

    const val SHELL_ATTACHED =
        """{"type":"shell_attached","shellId":"sh_1","cols":20,"rows":4,"scrollback":"hello\r\nworld","shell":{"id":"sh_1","sessionId":"s1","ordinal":2,"command":"bash","label":"bash","cwd":"/repo","owner":"user","status":"running","startedAt":1,"bytes":0,"cols":20,"rows":4}}"""

    fun session(): Session {
        val session = Session(0, true, "n", Metrics(8.0, 16.0, 800.0, 13.0), null)
        session.opened()
        return session
    }
}
