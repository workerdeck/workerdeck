package bi.atomic.workerdeck.app.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.session.SheetHeader
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ConversationItem
import kotlinx.coroutines.launch

// An agent's conversations, newest first. The current one opens the agent view (which follows); a past one opens
// read-only and never follows.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsSheet(
    target: ConversationsTarget,
    load: suspend () -> List<ConversationItem>?,
    onOpen: (sessionId: String, title: String) -> Unit,
    onOpenPast: (sessionId: String, title: String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = Wd.colors
    val state = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    var items by remember(target) { mutableStateOf<List<ConversationItem>?>(null) }
    var failed by remember(target) { mutableStateOf(false) }
    var attempt by remember(target) { mutableIntStateOf(0) }
    LaunchedEffect(target, attempt) {
        failed = false
        items = load()
        failed = items == null
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = if (colors.dark) colors.raised else colors.background) {
        Column(Modifier.navigationBarsPadding().testTag("conversations-sheet")) {
            SheetHeader(if (target.retired) "${target.name} (deleted)" else target.name, close)
            val shown = items
            when {
                shown != null -> LazyColumn(Modifier.padding(bottom = 16.dp)) {
                    items(shown, key = { it.sessionId }) { item ->
                        ConversationLine(item) {
                            if (item.current && !target.retired) onOpen(item.sessionId, item.title) else onOpenPast(item.sessionId, item.title)
                        }
                        HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 0.5.dp, color = colors.separator)
                    }
                }
                failed -> Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Conversations unavailable", style = MaterialTheme.typography.bodyMedium, color = colors.secondary)
                    TextButton(onClick = { attempt++ }) { Text("Retry", color = colors.accent) }
                }
                else -> Box(Modifier.fillMaxWidth().heightIn(min = 96.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

@Composable
private fun ConversationLine(item: ConversationItem, onClick: () -> Unit) {
    val colors = Wd.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp).testTag("conversation-${item.sessionId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                item.title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (item.unavailable) colors.secondary else colors.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(item.date, item.duration).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondary,
                maxLines = 1,
            )
        }
        if (item.current) Text("Current", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = colors.accent)
    }
}

// The deleted agents of every paired gateway; one opens its conversations.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PastAgentsSheet(entries: List<PastAgentEntry>, showGateway: (String) -> String?, onPick: (PastAgentEntry) -> Unit, onDismiss: () -> Unit) {
    val colors = Wd.colors
    val state = rememberModalBottomSheetState()
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = if (colors.dark) colors.raised else colors.background) {
        Column(Modifier.navigationBarsPadding().testTag("past-agents-sheet")) {
            SheetHeader("Past agents", close)
            LazyColumn(Modifier.padding(bottom = 16.dp)) {
                items(entries, key = { "${it.hostId}/${it.agent.id}" }) { entry ->
                    Column(Modifier.fillMaxWidth().clickable { onPick(entry) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                        Text(entry.agent.name, style = MaterialTheme.typography.bodyLarge, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(entry.agent.detail, showGateway(entry.hostId)).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.secondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 0.5.dp, color = colors.separator)
                }
            }
        }
    }
}
