package bi.atomic.workerdeck.app.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import bi.atomic.workerdeck.core.TranscriptLine

// Run intents are the markdown bits from crates/core/src/markdown.rs. Inline code draws as plain text, as on the web.
private const val EM = 1
private const val STRONG = 2
private const val STRIKE = 32

fun annotate(line: TranscriptLine, palette: Palette): AnnotatedString = buildAnnotatedString {
    if (line.nested) append("  ")
    if (line.gutter.isNotEmpty()) withStyle(SpanStyle(color = palette.tone(line.gutterTone))) { append(line.gutter) }
    if (line.indent > 0) append(" ".repeat(line.indent))
    val base = SpanStyle(
        color = palette.tone(line.tone),
        fontWeight = if (line.bold) FontWeight.Bold else null,
        fontStyle = if (line.italic) FontStyle.Italic else null,
    )
    withStyle(base) {
        var at = 0
        for (run in line.runs) {
            if (run.start > at) append(line.text.substring(at, run.start))
            withStyle(intentStyle(run.intent)) { append(line.text.substring(run.start, run.end)) }
            at = run.end
        }
        if (at < line.text.length) append(line.text.substring(at))
    }
}

private fun intentStyle(intent: Int) = SpanStyle(
    fontWeight = if (intent and STRONG != 0) FontWeight.Bold else null,
    fontStyle = if (intent and EM != 0) FontStyle.Italic else null,
    textDecoration = if (intent and STRIKE != 0) TextDecoration.LineThrough else null,
)
