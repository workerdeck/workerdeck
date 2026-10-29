package bi.atomic.workerdeck.app.sessions

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.TeamLead
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

// What a long-press drag carries: a group heading, or a card (with the team card it sits in, when it is a Member).
sealed interface DragItem {
    data class Heading(val key: String) : DragItem

    data class Card(val row: ListRow, val team: String?) : DragItem
}

// What letting go does. A heading lands on another heading; a card joins the lead it is over, or a Member let go
// outside its own team card leaves that team.
sealed interface DropAction {
    data class MoveGroup(val key: String, val onto: String) : DropAction

    data class Join(val row: ListRow, val lead: TeamLead) : DropAction

    data class Leave(val row: ListRow) : DropAction
}

// The card rules as plain data: `over` is the lead card under the finger (its session id), `leads` the ones the
// dragged row may join, `insideOwnTeam` whether a Member is still over its own team card.
fun cardDrop(member: Boolean, insideOwnTeam: Boolean, over: String?, leads: List<TeamLead>): CardDrop = when {
    over != null && leads.any { it.sessionId == over } -> CardDrop.Join(leads.first { it.sessionId == over })
    member && !insideOwnTeam -> CardDrop.Leave
    else -> CardDrop.None
}

sealed interface CardDrop {
    data class Join(val lead: TeamLead) : CardDrop

    data object Leave : CardDrop

    data object None : CardDrop
}

// One drag at a time across the list: every heading, card and team card registers its bounds in root coordinates,
// and the item under the finger is the target.
@Stable
class ListDrag(private val leadsOf: (ListRow) -> List<TeamLead>) {
    var item by mutableStateOf<DragItem?>(null)
        private set
    var lifted by mutableStateOf(false)
        private set
    var shift by mutableStateOf(Offset.Zero)
        private set
    private var pointer by mutableStateOf(Offset.Zero)
    private var leads: List<TeamLead> = emptyList()
    private val headings = HashMap<String, Rect>()
    private val cards = HashMap<String, Pair<ListRow, Rect>>()
    private val teams = HashMap<String, Rect>()

    fun heading(key: String, bounds: Rect?) = if (bounds == null) headings.remove(key) else headings[key] = bounds

    fun card(key: String, row: ListRow, bounds: Rect?) = if (bounds == null) cards.remove(key) else cards[key] = row to bounds

    fun team(key: String, bounds: Rect?) = if (bounds == null) teams.remove(key) else teams[key] = bounds

    fun press(what: DragItem, at: Offset) {
        item = what
        pointer = at
        shift = Offset.Zero
        lifted = false
        leads = (what as? DragItem.Card)?.let { leadsOf(it.row) }.orEmpty()
    }

    fun move(by: Offset, slop: Float) {
        pointer += by
        shift += by
        if (!lifted && shift.getDistance() > slop) lifted = true
    }

    fun cancel() {
        item = null
        lifted = false
        shift = Offset.Zero
    }

    // The heading key or lead card key the finger is over right now, for the highlight.
    val target: String?
        get() = when (val dragged = item.takeIf { lifted }) {
            is DragItem.Heading -> headings.entries.firstOrNull { it.key != dragged.key && it.value.contains(pointer) }?.key
            is DragItem.Card -> overLead(dragged)?.first?.takeIf { key -> leads.any { it.sessionId == cards[key]?.first?.sessionId } }
            null -> null
        }

    private fun overLead(dragged: DragItem.Card): Pair<String, ListRow>? = cards.entries
        .firstOrNull { (key, value) -> key != dragged.row.key && value.first.depth.toInt() == 0 && value.second.contains(pointer) }
        ?.let { it.key to it.value.first }

    fun drop(): DropAction? {
        val dragged = item.takeIf { lifted }
        val action = when (dragged) {
            is DragItem.Heading -> target?.let { DropAction.MoveGroup(dragged.key, it) }
            is DragItem.Card -> {
                val over = overLead(dragged)?.second?.takeIf { it.hostId == dragged.row.hostId }?.sessionId
                val inside = dragged.team?.let { teams[it]?.contains(pointer) } ?: false
                when (val drop = cardDrop(dragged.row.member, inside, over, leads)) {
                    is CardDrop.Join -> DropAction.Join(dragged.row, drop.lead)
                    CardDrop.Leave -> DropAction.Leave(dragged.row)
                    CardDrop.None -> null
                }
            }
            null -> null
        }
        cancel()
        return action
    }
}

// Registers a drop target's bounds while it is composed.
fun Modifier.dropBounds(register: (Rect?) -> Unit): Modifier = onGloballyPositioned { register(it.boundsInRoot()) }

@Composable
fun ForgetBounds(key: String, forget: () -> Unit) {
    DisposableEffect(key) { onDispose(forget) }
}

private sealed interface Press {
    data object Tap : Press

    data object Gone : Press
}

private suspend fun AwaitPointerEventScope.awaitRelease(id: PointerId, at: Offset, slop: Float): Press {
    while (true) {
        val change = awaitPointerEvent().changes.firstOrNull { it.id == id } ?: return Press.Gone
        if (change.changedToUp()) {
            change.consume()
            return Press.Tap
        }
        if (change.isConsumed || (change.position - at).getDistance() > slop) return Press.Gone
    }
}

// Tap, long press, and long-press drag on one element. A long press that never moves opens the menu; one that moves
// lifts the item and its release drops it. Before the long press nothing is consumed, so the list still scrolls and a
// row still swipes.
@Composable
fun Modifier.pressAndDrag(drag: ListDrag?, item: () -> DragItem?, onTap: () -> Unit, onMenu: () -> Unit, onDrop: (DropAction) -> Unit): Modifier {
    val haptics = LocalHapticFeedback.current
    val current by rememberUpdatedState(item)
    val tap by rememberUpdatedState(onTap)
    val menu by rememberUpdatedState(onMenu)
    val dropped by rememberUpdatedState(onDrop)
    var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val slop = with(LocalDensity.current) { 10.dp.toPx() }
    return onGloballyPositioned { coordinates = it }.pointerInput(drag) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val press = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { awaitRelease(down.id, down.position, viewConfiguration.touchSlop) }
            when (press) {
                Press.Tap -> {
                    tap()
                    return@awaitEachGesture
                }
                Press.Gone -> return@awaitEachGesture
                null -> Unit
            }
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            val what = current()
            val origin = coordinates?.localToRoot(down.position) ?: down.position
            if (what != null) drag?.press(what, origin)
            var moved = false
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Main)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (change.changedToUp()) {
                    change.consume()
                    break
                }
                val delta = change.position - change.previousPosition
                change.consume()
                if (what != null && drag != null) drag.move(delta, slop)
                if (drag?.lifted == true) moved = true
            }
            if (moved && drag != null) {
                drag.drop()?.let(dropped)
            } else {
                drag?.cancel()
                menu()
            }
        }
    }
}

// A button revealed behind a swiped card.
data class SwipeAction(val label: String, val color: Color, val run: () -> Unit)

private val ACTION_WIDTH = 76.dp

// The iOS row chrome: swipe right for the leading actions, left for the trailing (destructive) one. The card snaps
// open when dragged past half its actions and closes again on any action or a swipe back.
@Composable
fun SwipeRow(leading: List<SwipeAction>, trailing: List<SwipeAction>, shape: Shape, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val width = with(density) { ACTION_WIDTH.toPx() }
    val start = width * leading.size
    val end = width * trailing.size
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { offset.animateTo(0f) } }
    Box(modifier) {
        if (offset.value != 0f) {
            Row(Modifier.matchParentSize().clip(shape), horizontalArrangement = if (offset.value > 0) Arrangement.Start else Arrangement.End) {
                for (action in if (offset.value > 0) leading else trailing) {
                    Box(
                        Modifier.width(ACTION_WIDTH).fillMaxHeight().background(action.color).clickable {
                            close()
                            action.run()
                        },
                        contentAlignment = Alignment.Center,
                    ) { Text(action.label, color = Color.White, fontSize = 13.sp, lineHeight = 16.sp, modifier = Modifier.padding(horizontal = 4.dp)) }
                }
            }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    state = rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceIn(-end, start)) } },
                    orientation = Orientation.Horizontal,
                    enabled = leading.isNotEmpty() || trailing.isNotEmpty(),
                    onDragStopped = {
                        val value = offset.value
                        val target = when {
                            value > 0 && value > start / 2 -> start
                            value < 0 && abs(value) > end / 2 -> -end
                            else -> 0f
                        }
                        offset.animateTo(target)
                    },
                ),
        ) { content() }
    }
}
