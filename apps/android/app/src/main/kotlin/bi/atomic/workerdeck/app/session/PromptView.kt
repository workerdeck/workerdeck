package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.app.ui.annotate
import bi.atomic.workerdeck.core.TranscriptLine
import bi.atomic.workerdeck.core.ffi.ChoiceKey
import bi.atomic.workerdeck.core.ffi.Prompt
import bi.atomic.workerdeck.core.ffi.PromptKind
import bi.atomic.workerdeck.core.ffi.Question
import bi.atomic.workerdeck.core.ffi.Selection
import bi.atomic.workerdeck.core.ffi.answerText
import bi.atomic.workerdeck.core.ffi.toggleLabel
import bi.atomic.workerdeck.core.ffi.toggleOther

interface PromptActions {
    fun allow(requestId: String)

    fun deny(requestId: String, message: String?, interrupt: Boolean)

    fun answer(requestId: String, selections: List<Selection>)

    fun dismiss(requestId: String)
}

private class PromptType(val style: TextStyle, val cell: Dp, val line: Dp, val palette: Palette) {
    fun tone(name: String) = palette.toneNamed(name)
}

// The approval and question prompts of the iOS terminal theme: a docked strip ruled in the prompt's tint, a body that
// scrolls under a cap, and the actions pinned below it, so the thing that ends the prompt is always on screen.
@Composable
fun PendingPrompt(
    prompt: Prompt,
    planLines: List<TranscriptLine>,
    style: TextStyle,
    lineHeight: TextUnit,
    cell: Double,
    palette: Palette,
    maxBodyHeight: Dp,
    actions: PromptActions,
) {
    val density = LocalDensity.current
    val type = with(density) { PromptType(style, (cell * 2).toFloat().toDp(), lineHeight.toDp(), palette) }
    if (prompt.waiting > 1u) {
        Text(
            "1 of ${prompt.waiting} waiting",
            style = style.copy(color = Wd.colors.secondary, fontSize = style.fontSize * 0.85f),
            modifier = Modifier.padding(start = 8.dp, bottom = 2.dp),
        )
    }
    if (prompt.kind == PromptKind.QUESTION) {
        QuestionPrompt(prompt, type, maxBodyHeight, actions)
    } else {
        PermissionPrompt(prompt, planLines, type, maxBodyHeight, actions)
    }
}

@Composable
private fun PromptSurface(tint: Color, maxBodyHeight: Dp, body: @Composable () -> Unit, actions: @Composable RowScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().background(Wd.colors.background)) {
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(tint.copy(alpha = 0.5f)))
        Column(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 8.dp)) {
            Column(Modifier.fillMaxWidth().heightIn(max = maxBodyHeight).verticalScroll(rememberScrollState())) { body() }
            Box(Modifier.fillMaxWidth().padding(top = 8.dp).height(0.5.dp).background(Wd.colors.separator))
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) { actions() }
        }
        Box(Modifier.fillMaxWidth().height(0.5.dp).background(tint.copy(alpha = 0.5f)))
    }
}

@Composable
private fun PromptRow(type: PromptType, glyph: String = " ", glyphTone: String = "fg", content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(glyph, style = type.style.copy(color = type.tone(glyphTone)), modifier = Modifier.width(type.cell))
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun PromptText(type: PromptType, text: String, tone: String = "fg", bold: Boolean = false) {
    Text(text, style = type.style.copy(color = type.tone(tone), fontWeight = if (bold) FontWeight.SemiBold else null))
}

@Composable
private fun PromptChoice(
    type: PromptType,
    marker: String,
    label: String,
    selected: Boolean,
    danger: Boolean = false,
    detail: String? = null,
    preview: String? = null,
    onClick: () -> Unit,
) {
    val wash = if (selected) Wd.colors.accent.copy(alpha = 0.10f) else Color.Transparent
    Column(Modifier.fillMaxWidth().background(wash).clickable(onClick = onClick).padding(vertical = 2.dp)) {
        PromptRow(type, marker, if (selected) "blue" else "faint") {
            PromptText(type, label, if (danger) "red" else if (selected) "bright" else "fg", bold = selected)
        }
        if (!detail.isNullOrEmpty()) PromptRow(type) { PromptText(type, detail, "dim") }
        if (selected && !preview.isNullOrEmpty()) PromptRow(type) { PromptText(type, preview, "faint") }
    }
}

@Composable
private fun PromptButton(type: PromptType, title: String, tone: String, prominent: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val tint = type.tone(if (enabled) tone else "faint")
    Text(
        title,
        style = type.style.copy(color = tint, fontWeight = if (prominent) FontWeight.SemiBold else null),
        modifier = Modifier
            .background(if (prominent && enabled) tint.copy(alpha = 0.14f) else Color.Transparent)
            .border(0.5.dp, tint.copy(alpha = 0.35f))
            .let { if (enabled) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

@Composable
private fun ReasonField(type: PromptType, value: String, placeholder: String, onValue: (String) -> Unit) {
    PromptRow(type) {
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            if (value.isEmpty()) PromptText(type, placeholder, "faint")
            BasicTextField(
                value = value,
                onValueChange = onValue,
                textStyle = type.style.copy(color = type.tone("fg")),
                cursorBrush = SolidColor(Wd.colors.accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun PermissionPrompt(prompt: Prompt, planLines: List<TranscriptLine>, type: PromptType, maxBodyHeight: Dp, actions: PromptActions) {
    var denying by remember(prompt.requestId) { mutableStateOf(false) }
    var reason by remember(prompt.requestId) { mutableStateOf("") }
    val choice = { key: ChoiceKey -> prompt.choices.first { it.key == key } }
    fun deny(interrupt: Boolean) = actions.deny(prompt.requestId, reason.trim().ifEmpty { null }, interrupt)

    PromptSurface(
        tint = type.tone("yellow"),
        maxBodyHeight = maxBodyHeight,
        body = {
            PromptRow(type, "⚠", "yellow") { PromptText(type, prompt.heading, "bright", bold = true) }
            when (prompt.kind) {
                PromptKind.PLAN -> PlanLines(type, planLines)
                PromptKind.SHELL -> prompt.shellLines.forEach { PromptRow(type) { PromptText(type, it, "bright", bold = true) } }
                else -> prompt.subject?.let { PromptRow(type) { PromptText(type, it, "dim") } }
            }
            prompt.description?.takeIf { it.isNotEmpty() }?.let { PromptRow(type) { PromptText(type, it, "dim") } }
            prompt.decisionReason?.takeIf { it.isNotEmpty() }?.let { PromptRow(type) { PromptText(type, it, "faint") } }
            Spacer(Modifier.height(8.dp))
            PromptRow(type) { PromptText(type, prompt.question) }
            prompt.choices.forEachIndexed { index, c ->
                PromptChoice(type, "${index + 1}", c.option, selected = c.key == ChoiceKey.DENY && denying, danger = c.danger) {
                    when (c.key) {
                        ChoiceKey.ALLOW -> actions.allow(prompt.requestId)
                        ChoiceKey.DENY -> denying = !denying
                        ChoiceKey.STOP -> deny(interrupt = true)
                    }
                }
                if (c.key == ChoiceKey.DENY && denying) ReasonField(type, reason, prompt.denyPlaceholder) { reason = it }
            }
        },
        actions = {
            if (denying) {
                PromptButton(type, choice(ChoiceKey.DENY).button, "yellow", prominent = true) { deny(interrupt = false) }
                PromptButton(type, "Cancel", "dim") { denying = false }
            } else {
                PromptButton(type, choice(ChoiceKey.ALLOW).button, "green", prominent = true) { actions.allow(prompt.requestId) }
                PromptButton(type, choice(ChoiceKey.DENY).button, "yellow") { denying = true }
                Spacer(Modifier.weight(1f))
                PromptButton(type, choice(ChoiceKey.STOP).button, "red") { deny(interrupt = true) }
            }
        },
    )
}

@Composable
private fun PlanLines(type: PromptType, lines: List<TranscriptLine>) {
    Spacer(Modifier.height(4.dp))
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        lines.forEach { line ->
            Text(
                annotate(line, type.palette),
                style = type.style,
                softWrap = false,
                maxLines = 1,
                modifier = Modifier.height(type.line).background(type.palette.band(line.band)),
            )
        }
    }
}

// One question at a time behind a strip of chips, ending in a review step: answers given one screen at a time are
// answers you cannot see together, so the last chip shows all of them before they go back to the model.
@Composable
private fun QuestionPrompt(prompt: Prompt, type: PromptType, maxBodyHeight: Dp, actions: PromptActions) {
    val questions = prompt.questions
    val selections = remember(prompt.requestId) { mutableStateListOf(*Array(questions.size) { Selection(emptyList(), "", false) }) }
    var step by remember(prompt.requestId) { mutableStateOf(0) }
    val reviewing = step >= questions.size
    val answered = { index: Int -> answerText(selections[index]).isNotEmpty() }
    val complete = questions.indices.all(answered)

    PromptSurface(
        tint = type.tone("blue"),
        maxBodyHeight = maxBodyHeight,
        body = {
            PromptRow(type, "?", "blue") { PromptText(type, prompt.heading, "bright", bold = true) }
            if (questions.size > 1) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = type.cell, top = 4.dp, bottom = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    questions.forEachIndexed { index, q ->
                        Chip(type, q.header.ifEmpty { "Q${index + 1}" }, answered(index), step == index) { step = index }
                    }
                    Chip(type, "Review", false, reviewing) { step = questions.size }
                }
            }
            Spacer(Modifier.height(8.dp))
            if (reviewing) {
                questions.forEachIndexed { index, q ->
                    val answer = answerText(selections[index])
                    PromptRow(type) { PromptText(type, q.question, "dim") }
                    PromptRow(type, "⎿", "faint") { PromptText(type, answer.ifEmpty { "- not answered" }, if (answer.isEmpty()) "red" else "green") }
                    Spacer(Modifier.height(4.dp))
                }
            } else {
                QuestionBlock(type, questions[step], selections[step]) { selections[step] = it }
            }
        },
        actions = {
            if (step > 0) PromptButton(type, "Back", "dim") { step -= 1 }
            if (reviewing) {
                PromptButton(type, "Send", "blue", prominent = true, enabled = complete) { actions.answer(prompt.requestId, selections.toList()) }
            } else {
                PromptButton(type, if (step == questions.size - 1) "Review" else "Next", "blue", prominent = true, enabled = answered(step)) {
                    step += 1
                }
            }
            Spacer(Modifier.weight(1f))
            PromptButton(type, "Dismiss", "faint") { actions.dismiss(prompt.requestId) }
        },
    )
}

@Composable
private fun QuestionBlock(type: PromptType, question: Question, selection: Selection, onSelection: (Selection) -> Unit) {
    val multi = question.multiSelect
    PromptRow(type) { PromptText(type, question.question, bold = true) }
    if (multi) PromptRow(type) { PromptText(type, "Choose any that apply.", "faint") }
    Spacer(Modifier.height(4.dp))
    question.options.forEachIndexed { index, option ->
        val selected = option.label in selection.labels
        val marker = if (multi) (if (selected) "◆" else "◇") else (if (selected) "●" else "${index + 1}")
        val detail = listOfNotNull(if (index == 0) "recommended" else null, option.description).joinToString(" · ")
        PromptChoice(type, marker, option.label, selected, detail = detail, preview = option.preview) {
            onSelection(toggleLabel(selection, option.label, multi))
        }
    }
    val other = selection.otherActive
    val marker = if (multi) (if (other) "◆" else "◇") else (if (other) "●" else "${question.options.size + 1}")
    PromptChoice(type, marker, "Other", other) { onSelection(toggleOther(selection, multi)) }
    if (other) ReasonField(type, selection.other, "Your answer") { onSelection(selection.copy(other = it)) }
}

@Composable
private fun Chip(type: PromptType, title: String, answered: Boolean, active: Boolean, onClick: () -> Unit) {
    val tint = type.tone(if (active) "blue" else "faint")
    Text(
        if (answered) "$title ✓" else title,
        style = type.style.copy(color = type.tone(if (active) "bright" else if (answered) "green" else "faint")),
        modifier = Modifier
            .border(0.5.dp, tint.copy(alpha = if (active) 0.7f else 0.3f))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
