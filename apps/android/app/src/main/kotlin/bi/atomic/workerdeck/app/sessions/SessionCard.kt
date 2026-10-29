package bi.atomic.workerdeck.app.sessions

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.R
import bi.atomic.workerdeck.app.ui.BadgeGlyph
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.StateGlyph
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListChip
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.ListStep
import bi.atomic.workerdeck.core.ffi.RowState
import bi.atomic.workerdeck.core.ffi.StepFold
import bi.atomic.workerdeck.core.ffi.StepKind
import bi.atomic.workerdeck.core.ffi.StepState
import bi.atomic.workerdeck.core.ffi.TrayMember

// The session list's own tokens, the web theme's (`packages/ui/src/styles/theme.css`) for each scheme.
@Immutable
data class ListTones(
    val nest: Color,
    val attention: Color,
    val selected: Color,
    val name: Color,
    val fg1: Color,
    val fg2: Color,
    val fg3: Color,
    val fg4: Color,
    val shell: Color,
    val success: Color,
    val danger: Color,
    val warning: Color,
    val active: Color,
    val border: Color,
    val badge: Color,
    val badgeFg: Color,
    val accent: Color,
    val claude: Color,
)

fun listTones(dark: Boolean): ListTones = if (dark) {
    ListTones(
        nest = Color(0xFF232426), attention = Color(0xFF5C3906), selected = Color(0xFF04395E), name = Color(0xFFB8B8B8),
        fg1 = Color(0xFFEDEDED), fg2 = Color(0xFFA1A1A1), fg3 = Color(0xFF8F8F8F), fg4 = Color(0xFF6E6E6E),
        shell = Color(0xFFC586C0), success = Color(0xFF3ECF8E), danger = Color(0xFFFF6166), warning = Color(0xFFF5A623),
        active = Color.White.copy(alpha = 0.1f), border = Color(0xFF3D3D3D), badge = Color(0xFF616161), badgeFg = Color(0xFFCCCCCC),
        accent = Color(0xFF0078D4), claude = Color(0xFFCC7C5E),
    )
} else {
    ListTones(
        nest = Color(0xFFECECEC), attention = Color(0xFFFBDCB8), selected = Color(0xFFCFE4F7), name = Color(0xFF4A4A4A),
        fg1 = Color(0xFF171717), fg2 = Color(0xFF454545), fg3 = Color(0xFF737373), fg4 = Color(0xFFA1A1A1),
        shell = Color(0xFF8B3A8B), success = Color(0xFF0F7B4F), danger = Color(0xFFD93036), warning = Color(0xFFA35200),
        active = Color.Black.copy(alpha = 0.08f), border = Color(0xFFC9C9C9), badge = Color(0xFFC4C4C4), badgeFg = Color(0xFF333333),
        accent = Color(0xFF0078D4), claude = Color(0xFFB3573A),
    )
}

@Composable
fun rememberListTones(): ListTones {
    val dark = Wd.colors.dark
    return remember(dark) { listTones(dark) }
}

private val BODY = TextStyle(fontSize = 13.sp, lineHeight = 20.sp, letterSpacing = (-0.005).em)
private val LABEL = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = (-0.005).em)
private val MICRO = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = (-0.005).em)

val CARD_SHAPE = RoundedCornerShape(8.dp)
val MEMBER_SHAPE = RoundedCornerShape(4.dp)
const val TEAM_LINGER_MS = 5_000.0

// A card and the Members its team card holds: a lead's depth-1 rows follow it in the core's order.
data class CardUnit(val lead: ListRow, val members: List<ListRow>)

fun cardUnits(rows: List<ListRow>): List<CardUnit> {
    val units = mutableListOf<CardUnit>()
    for (row in rows) {
        val last = units.lastOrNull()
        if (row.depth > 0u && last != null) units[units.lastIndex] = last.copy(members = last.members + row) else units += CardUnit(row, emptyList())
    }
    return units
}

// What a card can ask of the screen; the screen owns navigation, the menu and the model.
class CardEvents(
    val onStep: (ListRow, ListStep) -> Unit,
    val onStopStep: (ListRow, ListStep) -> Unit,
    val onChip: (ListRow, StepFold) -> Unit,
    val onTrayMember: (TrayMember) -> Unit,
    val onToggleTeam: (ListRow) -> Unit,
)

fun needsYou(row: ListRow): Boolean = row.state == RowState.ATTENTION || row.teamState == RowState.ATTENTION

// The web `SessionItem` card: an agent (or, in tile mode, a plain session) as a 40 face beside two 20 lines; any other
// plain session in the gutter layout. `tray` is the lead's first-line team control.
@Composable
fun SessionCard(row: ListRow, tones: ListTones, events: CardEvents, icons: Map<String, ImageBitmap>, tray: (@Composable () -> Unit)?) {
    val agent = row.agentId != null
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("session-row")
            .alpha(if (row.context) 0.5f else 1f)
            .clip(CARD_SHAPE)
            .background(if (needsYou(row)) tones.attention else Color.Transparent)
            .padding(4.dp),
    ) {
        if (agent || row.tile) {
            Row(Modifier.height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentAvatar(row, 40.dp, context = agent)
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f).padding(end = 2.dp).alpha(if (row.asleep) 0.6f else 1f)) {
                    Row(Modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Name(row, tones, BODY, Modifier.weight(1f, fill = false))
                            if (row.lead) LeadChip(tones)
                            if (row.shared) Icon(painterResource(R.drawable.globe), contentDescription = "Shared with other owners", tint = tones.fg4, modifier = Modifier.size(12.dp))
                        }
                        Unread(row, tones)
                        tray?.invoke()
                        if (!agent) ContextRing(row.contextPercent, tones)
                    }
                    Row(Modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (agent) {
                            Text(agentLine(row, tones), style = BODY, color = tones.fg4, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        } else {
                            DetailLine(row, tones, icons, Modifier.weight(1f))
                        }
                        Chips(row, tones, events)
                    }
                }
            }
        } else {
            Column(Modifier.padding(start = 6.dp, end = 2.dp, top = 2.dp, bottom = 2.dp).alpha(if (row.asleep) 0.6f else 1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                        row.badge?.let { BadgeGlyph(it, size = 14.dp) } ?: StateGlyph(row.state)
                    }
                    Name(row, tones, BODY, Modifier.weight(1f))
                    Unread(row, tones)
                    ContextRing(row.contextPercent, tones)
                }
                Row(Modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) { EngineMark(row.mark, row.markTinted, size = 16.dp) }
                    DetailLine(row, tones, icons, Modifier.weight(1f))
                    Chips(row, tones, events)
                }
            }
        }
        StepRows(row, tones, events)
    }
}

// A Member inside its team card: a 32 face and 12 gap, two 16 lines.
@Composable
fun MemberCard(row: ListRow, tones: ListTones, events: CardEvents) {
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("session-row")
            .clip(MEMBER_SHAPE)
            .background(if (needsYou(row)) tones.attention else Color.Transparent)
            .padding(4.dp),
    ) {
        Row(Modifier.height(32.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentAvatar(row, 32.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f).alpha(if (row.asleep) 0.6f else 1f)) {
                Row(Modifier.height(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Name(row, tones, BODY.copy(lineHeight = 16.sp), Modifier.weight(1f))
                    Unread(row, tones)
                    Chips(row, tones, events)
                }
                Text(agentLine(row, tones), style = LABEL, color = tones.fg4, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.height(16.dp))
            }
        }
        StepRows(row, tones, events)
    }
}

// A Member Auto keeps only for its linger window: a hairline that fills left to right, then the row leaves.
@Composable
fun LingerBar(start: Double, tones: ListTones, modifier: Modifier = Modifier) {
    val progress = remember(start) { Animatable(((System.currentTimeMillis() - start) / TEAM_LINGER_MS).toFloat().coerceIn(0f, 1f)) }
    LaunchedEffect(start) {
        val left = (start + TEAM_LINGER_MS - System.currentTimeMillis()).toLong()
        if (left > 0) progress.animateTo(1f, tween(left.toInt(), easing = LinearEasing))
    }
    Canvas(modifier.fillMaxWidth().height(2.dp)) {
        drawLine(
            tones.fg4.copy(alpha = 0.5f),
            Offset(size.height / 2, size.height / 2),
            Offset(size.height / 2 + (size.width - size.height) * progress.value, size.height / 2),
            strokeWidth = size.height,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun Name(row: ListRow, tones: ListTones, style: TextStyle, modifier: Modifier) {
    Text(
        row.title,
        style = style,
        fontWeight = FontWeight.Medium,
        color = if (row.agentId != null) tones.name else tones.fg1,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

@Composable
fun LeadChip(tones: ListTones) {
    Box(Modifier.border(1.dp, tones.accent.copy(alpha = 0.5f), RoundedCornerShape(3.dp)).padding(horizontal = 4.dp)) {
        Text("LEAD", fontSize = 10.sp, lineHeight = 14.sp, letterSpacing = 0.025.em, fontWeight = FontWeight.Medium, color = tones.accent)
    }
}

// Grey while the turn still produces, accent once it stopped: the colour answers "is this waiting for me".
@Composable
private fun Unread(row: ListRow, tones: ListTones) {
    if (row.unseen == 0u) return
    val working = row.state == RowState.WORKING
    Box(
        Modifier.height(16.dp).widthIn(min = 24.dp).clip(RoundedCornerShape(50)).background(if (working) tones.badge else tones.accent).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(row.unseen.toString(), fontSize = 12.sp, lineHeight = 12.sp, color = if (working) tones.badgeFg else Color.White)
    }
}

@Composable
private fun ContextRing(percent: Double?, tones: ListTones) {
    percent ?: return
    val tint = when {
        percent >= 95 -> tones.danger
        percent >= 80 -> tones.warning
        else -> tones.fg3
    }
    Canvas(Modifier.padding(2.dp).size(16.dp).semantics { contentDescription = "Context ${percent.toInt()}%" }) {
        val stroke = 2.dp.toPx()
        val inset = stroke / 2
        val box = Size(size.width - stroke, size.height - stroke)
        drawArc(tint.copy(alpha = 0.2f), 0f, 360f, false, Offset(inset, inset), box, style = Stroke(stroke))
        drawArc(tint, -90f, 360f * (percent.coerceIn(0.0, 100.0) / 100).toFloat(), false, Offset(inset, inset), box, style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

private fun modelColor(row: ListRow, tones: ListTones): Color = if (row.nameTinted) tones.claude else tones.fg3

// An agent's second line: its model in the vendor's colour, then its status.
private fun agentLine(row: ListRow, tones: ListTones) = buildAnnotatedString {
    row.modelLabel?.let { withStyle(SpanStyle(color = modelColor(row, tones))) { append(it) } }
    row.status?.let { status ->
        withStyle(SpanStyle(color = tones.fg3)) { append(if (row.modelLabel != null) " · $status" else status) }
    }
}

private const val PROJECT_ICON = "project"

@Composable
private fun DetailLine(row: ListRow, tones: ListTones, icons: Map<String, ImageBitmap>, modifier: Modifier) {
    val inline = mapOf(
        PROJECT_ICON to InlineTextContent(Placeholder(16.sp, 16.sp, PlaceholderVerticalAlign.Center)) {
            ProjectIcon(row.projectIconHash, row.projectGlyph, icons, tones, 16.dp)
        },
    )
    Text(detailLine(row, tones), style = BODY, color = tones.fg4, maxLines = 1, overflow = TextOverflow.Ellipsis, inlineContent = inline, modifier = modifier)
}

// A plain session's second line: model · status · project · gateway · @profile · cost.
private fun detailLine(row: ListRow, tones: ListTones) = buildAnnotatedString {
    var first = true
    fun part(text: String, color: Color = tones.fg4) {
        if (!first) append(" · ")
        first = false
        withStyle(SpanStyle(color = color)) { append(text) }
    }
    row.modelLabel?.let { part(it, modelColor(row, tones)) }
    row.status?.let { part(it, tones.fg3) }
    if (row.project.isNotEmpty()) {
        if (!first) append(" · ")
        first = false
        if (row.projectIconHash != null || row.projectGlyph != null) {
            appendInlineContent(PROJECT_ICON, "[icon]")
            append(" ")
        }
        withStyle(SpanStyle(color = tones.fg4)) { append(row.project) }
    }
    if (row.showGateway && row.hostName.isNotEmpty()) part(row.hostName)
    row.profile?.let { part("@$it") }
    row.costText?.let { part(it) }
}

@Composable
private fun Chips(row: ListRow, tones: ListTones, events: CardEvents) {
    for (chip in row.chips) StepChip(chip, tones) { events.onChip(row, chip.kind) }
}

@Composable
private fun StepChip(chip: ListChip, tones: ListTones, onToggle: () -> Unit) {
    val tint = when {
        chip.failed -> tones.danger
        chip.kind == StepFold.SHELL -> tones.shell
        chip.running > 0u -> if (chip.kind == StepFold.AGENT) tones.success else tones.fg2
        else -> tones.fg4
    }
    Row(
        Modifier
            .height(16.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(if (chip.open) tones.active else Color.Transparent)
            .clickable(onClick = onToggle)
            .semantics { contentDescription = "${if (chip.open) "Hide" else "Show"} ${chip.label}" }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        when (chip.kind) {
            StepFold.SHELL -> Text("$", style = MICRO, color = tint)
            StepFold.BASH -> Icon(painterResource(R.drawable.chip_bash), contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
            StepFold.TASK -> Icon(painterResource(R.drawable.chip_task), contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
            StepFold.AGENT -> Icon(painterResource(R.drawable.chip_agent), contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
        }
        Text(chip.count.toString(), style = MICRO, color = tint)
    }
}

@Composable
private fun StepRows(row: ListRow, tones: ListTones, events: CardEvents) {
    for (step in row.steps) StepLine(step, tones, onOpen = { events.onStep(row, step) }, onStop = { events.onStopStep(row, step) })
}

// The web `StepRow`: the state's mark, the label, the reading, and stop or kill where it can.
@Composable
private fun StepLine(step: ListStep, tones: ListTones, onOpen: () -> Unit, onStop: () -> Unit) {
    val tone = when {
        step.state == StepState.FAILED -> tones.danger
        step.kind == StepKind.SHELL -> tones.shell
        step.kind == StepKind.TASK -> if (step.state == StepState.PENDING) tones.fg4 else tones.fg2
        else -> tones.success
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 22.dp).clip(MEMBER_SHAPE).clickable(onClick = onOpen).semantics { contentDescription = step.title }
            .padding(start = 14.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.width(11.dp), contentAlignment = Alignment.Center) {
            when {
                step.kind == StepKind.SHELL -> Text("$", style = MICRO, color = tone)
                step.state == StepState.RUNNING -> CircularProgressIndicator(Modifier.size(10.dp), color = tone, strokeWidth = 1.5.dp)
                step.state == StepState.FAILED -> Icon(painterResource(R.drawable.badge_failed), contentDescription = null, tint = tone, modifier = Modifier.size(11.dp))
                step.state == StepState.DONE -> Text("✓", style = MICRO, color = tone)
                else -> Box(Modifier.size(9.dp).border(1.25.dp, tone, RoundedCornerShape(50)))
            }
        }
        Text(
            step.label,
            style = MICRO,
            color = tone,
            fontFamily = if (step.kind == StepKind.SHELL) FontFamily.Monospace else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        step.detail?.let { Text(it, style = MICRO, color = tones.fg4, maxLines = 1) }
        if (step.kind == StepKind.AGENT) Icon(painterResource(R.drawable.chevron_right), contentDescription = null, tint = tones.fg4, modifier = Modifier.size(14.dp))
        if (step.killable) {
            Box(
                Modifier.size(22.dp).clip(MEMBER_SHAPE).clickable(onClick = onStop)
                    .semantics { contentDescription = if (step.kind == StepKind.TASK) "Stop ${step.label}" else "Kill ${step.label}" },
                contentAlignment = Alignment.Center,
            ) { Text("✕", style = MICRO, color = tones.fg4) }
        }
    }
}

// Auto's tray on the lead's first line: up to four idle Members as 16 faces (a tap opens one), then `+N` or a chevron
// that expands the team. Expanded, `^ N` returns it to Auto.
@Composable
fun TeamTray(row: ListRow, tones: ListTones, onOpenMember: (TrayMember) -> Unit, onToggle: () -> Unit) {
    if (row.tray.isEmpty() && !row.teamExpanded) return
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (row.tray.isNotEmpty()) {
            for (member in row.tray) {
                Box(Modifier.clip(RoundedCornerShape(3.dp)).clickable { onOpenMember(member) }.semantics { contentDescription = "Open ${member.title}" }) {
                    TrayAvatar(member, 16.dp)
                }
            }
            TrayButton(tones, "Show all Team Members", onToggle) {
                if (row.trayOverflow > 0u) {
                    Text("+${row.trayOverflow}", style = LABEL, color = tones.fg4)
                } else {
                    Icon(painterResource(R.drawable.chevron_right), contentDescription = null, tint = tones.fg4, modifier = Modifier.size(12.dp))
                }
            }
        } else {
            TrayButton(tones, "Show only active Members", onToggle) {
                Icon(painterResource(R.drawable.chevron_up), contentDescription = null, tint = tones.fg3, modifier = Modifier.size(12.dp))
                Text(row.members.toString(), style = LABEL, color = tones.fg3)
            }
        }
    }
}

@Composable
private fun TrayButton(tones: ListTones, label: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    Row(
        Modifier.height(16.dp).clip(MEMBER_SHAPE).clickable(onClick = onClick).semantics { contentDescription = label }.padding(horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) { content() }
}

// A project heading's picture: the gateway's image when it is in, else a folder for a glyph or an image still loading.
@Composable
fun ProjectIcon(hash: String?, glyph: String?, icons: Map<String, ImageBitmap>, tones: ListTones, size: Dp) {
    val image = hash?.let { icons[it] }
    when {
        image != null -> Image(image, contentDescription = null, modifier = Modifier.size(size).clip(RoundedCornerShape(3.dp)))
        hash != null || glyph != null -> Icon(painterResource(R.drawable.project_folder), contentDescription = null, tint = tones.fg4, modifier = Modifier.size(size))
    }
}
