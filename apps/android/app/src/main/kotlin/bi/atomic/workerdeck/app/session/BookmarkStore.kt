package bi.atomic.workerdeck.app.session

import android.content.Context
import android.content.SharedPreferences
import bi.atomic.workerdeck.core.ffi.Bookmarks
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

// The reader's bookmarks, one map for every gateway: the core's `Bookmarks` holds the rules, this keeps its JSON in
// preferences and bumps `revision` so a screen re-reads after a toggle.
class BookmarkStore private constructor(private val prefs: SharedPreferences) {
    private val marks = Bookmarks(prefs.getString(KEY, null))
    private val changes = MutableStateFlow(0)
    val revision: StateFlow<Int> = changes

    // Marks belong to one conversation of the session: `conversation` is the one the screen shows.
    fun forSession(hostId: String, sessionId: String, conversation: Long): List<String> = marks.forSession(hostId, sessionId, conversation)

    fun contains(hostId: String, sessionId: String, conversation: Long, itemId: String): Boolean =
        marks.contains(hostId, sessionId, conversation, itemId)

    fun toggle(hostId: String, sessionId: String, conversation: Long, itemId: String): Boolean =
        marks.toggle(hostId, sessionId, conversation, itemId).also { save() }

    fun removeHost(hostId: String) {
        if (marks.removeHost(hostId)) save()
    }

    private fun save() {
        prefs.edit().putString(KEY, marks.toJson()).apply()
        changes.value += 1
    }

    companion object {
        private const val KEY = "v1"

        @Volatile private var shared: BookmarkStore? = null

        fun of(context: Context): BookmarkStore = shared ?: synchronized(this) {
            shared ?: BookmarkStore(context.applicationContext.getSharedPreferences("bookmarks", Context.MODE_PRIVATE)).also { shared = it }
        }
    }
}
