package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.GoalCapabilities
import bi.atomic.workerdeck.core.ffi.GoalStateKind
import bi.atomic.workerdeck.core.ffi.GoalSubmit
import bi.atomic.workerdeck.core.ffi.GoalView
import bi.atomic.workerdeck.core.ffi.HttpCall
import bi.atomic.workerdeck.core.ffi.SessionChrome
import bi.atomic.workerdeck.core.ffi.ago
import bi.atomic.workerdeck.core.ffi.clearGoalCall
import bi.atomic.workerdeck.core.ffi.goalHoldsEngineHint
import bi.atomic.workerdeck.core.ffi.goalTextMax
import bi.atomic.workerdeck.core.ffi.pauseGoalCall
import bi.atomic.workerdeck.core.ffi.setGoalCall

// What the Set goal dialog opened over: `replacing` prefills it, `conversation` is the generation every call names.
class GoalRequest(val goals: GoalCapabilities, val replacing: GoalView?, val conversation: Long)

// The session menu's goal block; offered only on a live, enabled session whose engine has goals.
class GoalMenu(
    val sessionId: String,
    val goal: GoalView?,
    val goals: GoalCapabilities,
    val conversation: Long,
    val onSet: (GoalRequest) -> Unit,
    val onCall: (String, HttpCall) -> Unit,
)

fun goalMenu(chrome: SessionChrome?, sessionId: String, onSet: (GoalRequest) -> Unit, onCall: (String, HttpCall) -> Unit): GoalMenu? {
    chrome ?: return null
    val goals = chrome.goals ?: return null
    val n = chrome.conversation ?: return null
    if (chrome.historical || !chrome.enabled) return null
    return GoalMenu(sessionId, chrome.goal, goals, n, onSet, onCall)
}

@Composable
fun ColumnScope.GoalMenuItems(menu: GoalMenu, close: () -> Unit) {
    val goal = menu.goal
    val id = menu.sessionId
    val n = menu.conversation
    HorizontalDivider(color = Wd.colors.separator)
    DropdownMenuItem(
        text = { Text(if (goal != null && goal.state != GoalStateKind.MET) "Replace goal…" else "Set goal…") },
        onClick = {
            close()
            menu.onSet(GoalRequest(menu.goals, goal?.takeIf { it.state != GoalStateKind.MET }, n))
        },
    )
    val state = goal?.state
    if (menu.goals.pause && (state == GoalStateKind.ACTIVE || state == GoalStateKind.PAUSED)) {
        val pausing = state == GoalStateKind.ACTIVE
        DropdownMenuItem(
            text = { Text(if (pausing) "Pause goal" else "Resume goal") },
            onClick = {
                close()
                menu.onCall(if (pausing) "Could not pause the goal" else "Could not resume the goal", pauseGoalCall(id, pausing, n))
            },
        )
    }
    if (goal != null) {
        DropdownMenuItem(
            text = { Text("Clear goal") },
            onClick = {
                close()
                menu.onCall("Could not clear the goal", clearGoalCall(id, n))
            },
        )
    }
}

@Composable
fun GoalDialog(request: GoalRequest, sessionId: String, onDismiss: () -> Unit, onSend: (HttpCall) -> Unit) {
    val colors = Wd.colors
    var text by remember(request) { mutableStateOf(request.replacing?.text.orEmpty()) }
    var budget by remember(request) { mutableStateOf(request.replacing?.tokenBudget?.toString().orEmpty()) }
    var refusal by remember(request) { mutableStateOf<String?>(null) }
    val max = remember { goalTextMax().toInt() }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val replacing = request.replacing != null
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (replacing) "Replace goal" else "Set goal") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    text,
                    { next ->
                        refusal = null
                        text = clip(next, max)
                    },
                    placeholder = { Text("When is the work done? e.g. all tests in packages/core pass") },
                    minLines = 4,
                    maxLines = 12,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).focusRequester(focus).testTag("goal-text"),
                )
                Text(
                    if (request.goals.budget) {
                        "The agent keeps working, turn after turn, until the goal is met. The engine stops at the token budget."
                    } else {
                        "The agent keeps working, turn after turn, until the goal is met. Each turn ends with a check against it."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondary,
                )
                if (request.goals.budget) {
                    OutlinedTextField(
                        budget,
                        { next ->
                            refusal = null
                            budget = next.filter { it in '0'..'9' }
                        },
                        label = { Text("Token budget") },
                        placeholder = { Text("No budget") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth().testTag("goal-budget"),
                    )
                }
                refusal?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = colors.red, modifier = Modifier.testTag("goal-refusal"))
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = text.isNotBlank(),
                onClick = {
                    when (val submit = setGoalCall(sessionId, text, budget, request.replacing?.tokenBudget, request.goals, request.conversation)) {
                        is GoalSubmit.Refused -> refusal = submit.message
                        is GoalSubmit.Send -> {
                            onDismiss()
                            onSend(submit.call)
                        }
                    }
                },
            ) { Text(if (replacing) "Replace" else "Set") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// Capped in UTF-16 units, the unit the core counts; a cut never leaves half a surrogate pair.
private fun clip(text: String, max: Int): String {
    if (text.length <= max) return text
    val cut = text.take(max)
    return if (cut.last().isHighSurrogate()) cut.dropLast(1) else cut
}

@Composable
fun GoalInfo(goal: GoalView) {
    val colors = Wd.colors
    val rows = listOfNotNull<@Composable () -> Unit>(
        { GoalBlock("Goal", goal.text, colors.primary) },
        { GoalRow("Goal state", goal.stateText) },
        { GoalRow("Set by", "${goal.setBy}, ${setAgo(goal.setAt)}") },
        goal.checks?.takeIf { it > 0u }?.let { { GoalRow("Checks not met", it.toString()) } },
        goal.lastReason?.takeIf { it.isNotEmpty() }?.let { { GoalBlock("Last reason", it, colors.secondary) } },
        goal.tokensText?.let { { GoalRow("Goal tokens", it) } },
        goal.timeText?.let { { GoalRow("Goal time", it) } },
    )
    Box(Modifier.padding(top = 16.dp))
    SheetSection {
        rows.forEachIndexed { index, row ->
            if (index > 0) SheetDivider()
            row()
        }
    }
    if (goal.holdsEngine) {
        Text(
            goalHoldsEngineHint(),
            style = MaterialTheme.typography.bodySmall,
            color = colors.secondary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun GoalRow(label: String, value: String) = LabelRow(label, value, Modifier.padding(horizontal = 16.dp, vertical = 12.dp))

@Composable
private fun GoalBlock(label: String, value: String, tone: Color) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Wd.colors.secondary)
        SelectionContainer { Text(value, style = MaterialTheme.typography.bodyLarge, color = tone) }
    }
}

private fun setAgo(setAt: Long): String {
    val text = ago(setAt.toDouble(), System.currentTimeMillis().toDouble())
    return if (text == "just now") text else "$text ago"
}
