package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.ui.platform.LocalContext

// The web's labels, as iOS draws them: Move to background, Bookmark / Remove bookmark, Copy. Copy puts the row's
// source on the clipboard (the core's `copy_text`), never its drawn lines.
@Composable
fun ColumnScope.RowMenuItems(
    open: OpenRowMenu,
    bookmarked: Boolean,
    onBackground: (String) -> Unit,
    onToggleBookmark: (String) -> Unit,
    onDone: () -> Unit,
) {
    val context = LocalContext.current
    open.menu.backgroundCallId?.let { id ->
        DropdownMenuItem(text = { Text("Move to background") }, onClick = {
            onBackground(id)
            onDone()
        })
    }
    open.menu.bookmarkItemId?.let { id ->
        DropdownMenuItem(text = { Text(if (bookmarked) "Remove bookmark" else "Bookmark") }, onClick = {
            onToggleBookmark(id)
            onDone()
        })
    }
    open.menu.copyText?.let { text ->
        DropdownMenuItem(text = { Text("Copy") }, onClick = {
            // Synchronous on purpose: the menu leaves composition on `onDone`, which would cancel a suspend write.
            context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("WorkerDeck", text))
            onDone()
        })
    }
}

// One session's bookmarks: the shared store, addressed by gateway id and session id.
class SessionBookmarks(private val store: BookmarkStore, private val hostId: String, private val sessionId: String) {
    val revision get() = store.revision

    fun contains(itemId: String) = store.contains(hostId, sessionId, itemId)

    fun ids(): List<String> = store.forSession(hostId, sessionId)

    fun toggle(itemId: String) = store.toggle(hostId, sessionId, itemId)
}

@Composable
fun rememberRowMenuHost(model: SessionModel, bookmarks: SessionBookmarks, inFrame: Boolean): RowMenuHost {
    val open by model.menu.collectAsStateWithLifecycle()
    val mine = open?.takeIf { it.inFrame == inFrame }
    return RowMenuHost(
        openRow = mine?.row,
        onLongPress = { row -> model.openMenu(row, inFrame) },
        onDismiss = model::closeMenu,
        content = {
            if (mine != null) {
                val bookmarked = mine.menu.bookmarkItemId?.let(bookmarks::contains) == true
                RowMenuItems(mine, bookmarked, model::backgroundTask, { bookmarks.toggle(it) }, model::closeMenu)
            }
        },
    )
}
