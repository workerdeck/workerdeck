package bi.atomic.workerdeck.app.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import bi.atomic.workerdeck.R
import bi.atomic.workerdeck.app.session.Entry
import bi.atomic.workerdeck.core.ffi.ListGroup
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.ListStep
import bi.atomic.workerdeck.core.ffi.StepKind

// Everything a card offers besides opening: its swipe actions and its long-press menu.
class RowChrome(val leading: List<SwipeAction>, val trailing: List<SwipeAction>)

class ListEvents(
    val card: CardEvents,
    val open: (ListRow) -> Unit,
    val chrome: (ListRow) -> RowChrome,
    val menu: @Composable (row: ListRow, open: Boolean, dismiss: () -> Unit) -> Unit,
    val drop: (DropAction) -> Unit,
    val toggleGroup: (String) -> Unit,
    val newIn: (hostId: String, cwd: String) -> Unit,
)

// The web session browser's column: headings, then each card or team card with a 4 dp gap and no dividers.
@Composable
fun SessionsList(groups: List<ListGroup>, error: String?, icons: Map<String, ImageBitmap>, drag: ListDrag, events: ListEvents) {
    val tones = rememberListTones()
    LazyColumn(Modifier.fillMaxSize().testTag("sessions"), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
        error?.let { item(key = "error") { Text(it, color = tones.danger, fontSize = 13.sp, modifier = Modifier.padding(8.dp)) } }
        for (group in groups) {
            group.label?.let { label ->
                item(key = "group:${group.key}") {
                    val lifted = drag.lifted && (drag.item as? DragItem.Heading)?.key == group.key
                    GroupHeading(group, label, tones, icons, drag, events, Modifier.zIndex(if (lifted) 1f else 0f))
                }
            }
            if (!group.collapsed) {
                items(cardUnits(group.rows), key = { "${group.key}/${it.lead.key}" }) { unit ->
                    val lifted = drag.lifted && (drag.item as? DragItem.Card)?.row?.key.let { key -> key == unit.lead.key || unit.members.any { it.key == key } }
                    Box(Modifier.zIndex(if (lifted) 1f else 0f).padding(bottom = 4.dp)) { CardUnitView(unit, tones, icons, drag, events) }
                }
            }
        }
    }
}

@Composable
private fun CardUnitView(unit: CardUnit, tones: ListTones, icons: Map<String, ImageBitmap>, drag: ListDrag, events: ListEvents) {
    val lead = unit.lead
    val tray: @Composable () -> Unit = { TeamTray(lead, tones, onOpenMember = events.card.onTrayMember, onToggle = { events.card.onToggleTeam(lead) }) }
    if (unit.members.isEmpty()) {
        Chromed(lead, null, CARD_SHAPE, tones, drag, events) { SessionCard(lead, tones, events.card, icons, tray.takeIf { lead.members > 0u }) }
        return
    }
    Column(
        Modifier.fillMaxWidth().clip(CARD_SHAPE).background(tones.nest).dropBounds { drag.team(lead.key, it) },
    ) {
        Chromed(lead, null, CARD_SHAPE, tones, drag, events) { SessionCard(lead, tones, events.card, icons, tray) }
        Column(Modifier.padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (member in unit.members) {
                Box {
                    Chromed(member, lead.key, MEMBER_SHAPE, tones, drag, events) { MemberCard(member, tones, events.card) }
                    member.lingerStart?.let { LingerBar(it, tones, Modifier.align(Alignment.BottomCenter).padding(horizontal = 8.dp)) }
                }
            }
        }
    }
    ForgetBounds(lead.key) { drag.team(lead.key, null) }
}

// One card with the row chrome: swipes, the long-press menu, and long-press drag onto a lead.
@Composable
private fun Chromed(row: ListRow, team: String?, shape: Shape, tones: ListTones, drag: ListDrag, events: ListEvents, content: @Composable () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val chrome = events.chrome(row)
    val lifted = drag.lifted && (drag.item as? DragItem.Card)?.row?.key == row.key
    val target = drag.target == row.key
    Box(Modifier.dropBounds { drag.card(row.key, row, it) }) {
        SwipeRow(chrome.leading, chrome.trailing, shape) {
            Box(
                Modifier
                    .graphicsLayer {
                        if (lifted) {
                            translationX = drag.shift.x
                            translationY = drag.shift.y
                            shadowElevation = 8.dp.toPx()
                            this.shape = shape
                            clip = true
                        }
                    }
                    .then(if (target) Modifier.border(1.5.dp, tones.accent, shape) else Modifier)
                    .pressAndDrag(drag, { DragItem.Card(row, team) }, onTap = { events.open(row) }, onMenu = { menu = true }, onDrop = events.drop),
            ) { content() }
        }
        events.menu(row, menu) { menu = false }
    }
    ForgetBounds(row.key) { drag.card(row.key, row, null) }
}

// The web `FacetGroupHeader`: fold chevron, project icon, label (capitals for a facet), gateway badge, count, the
// folded summary, and `+` for a new session in a project. A reorderable heading drags onto another.
@Composable
private fun GroupHeading(group: ListGroup, label: String, tones: ListTones, icons: Map<String, ImageBitmap>, drag: ListDrag, events: ListEvents, modifier: Modifier) {
    val lifted = drag.lifted && (drag.item as? DragItem.Heading)?.key == group.key
    val target = drag.target == group.key
    val shape = RoundedCornerShape(4.dp)
    Row(
        modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 4.dp)
            .dropBounds { if (group.reorderable) drag.heading(group.key, it) }
            .graphicsLayer {
                if (lifted) {
                    translationY = drag.shift.y
                    shadowElevation = 6.dp.toPx()
                    this.shape = shape
                    clip = true
                }
            }
            .background(if (lifted) tones.nest else Color.Transparent, shape)
            .then(if (target) Modifier.border(1.5.dp, tones.accent, shape) else Modifier)
            .pressAndDrag(
                if (group.reorderable) drag else null,
                { DragItem.Heading(group.key).takeIf { group.reorderable } },
                onTap = { events.toggleGroup(group.key) },
                onMenu = {},
                onDrop = events.drop,
            )
            .heightIn(min = 20.dp)
            .padding(horizontal = 8.dp)
            .semantics { contentDescription = "${if (group.collapsed) "Expand" else "Collapse"} $label" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            painterResource(if (group.collapsed) R.drawable.chevron_right else R.drawable.chevron_down),
            contentDescription = null,
            tint = tones.fg4,
            modifier = Modifier.size(14.dp),
        )
        ProjectIcon(group.projectIconHash, group.projectGlyph, icons, tones, 16.dp)
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (group.caps) label.uppercase() else label,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = if (group.caps) 0.025.em else 0.em,
                color = if (group.caps) tones.fg4 else tones.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            group.gateway?.let { gateway ->
                Box(Modifier.border(1.dp, tones.border, RoundedCornerShape(2.dp)).padding(horizontal = 4.dp)) {
                    Text(gateway, fontSize = 12.sp, lineHeight = 16.sp, color = tones.fg4, maxLines = 1)
                }
            }
            Text(group.sessions.toString(), fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, color = tones.fg4.copy(alpha = 0.7f))
            group.foldSummary?.let { summary ->
                Text(
                    summary,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (group.foldAttention) tones.warning else tones.fg4.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
        val host = group.hostId
        val cwd = group.cwd
        if (host != null && cwd != null && !group.earlier) {
            Box(
                Modifier.size(20.dp).clip(shape).clickable { events.newIn(host, cwd) }.semantics { contentDescription = "New session in $label" },
                contentAlignment = Alignment.Center,
            ) { Icon(painterResource(R.drawable.plus), contentDescription = null, tint = tones.fg3, modifier = Modifier.size(14.dp)) }
        }
    }
    ForgetBounds("group:${group.key}") { drag.heading(group.key, null) }
}

// An agent opens its takeover, a task its call's row (a checklist item, with no call, just the session), a shell its screen.
fun stepEntry(step: ListStep): Entry? = when (step.kind) {
    StepKind.AGENT -> Entry.Subagent(step.key)
    StepKind.TASK -> step.toolUseId?.let(Entry::Reveal)
    StepKind.SHELL -> Entry.Shell(step.key)
}
