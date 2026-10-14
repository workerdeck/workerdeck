package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import bi.atomic.workerdeck.app.ui.Palette
import bi.atomic.workerdeck.app.ui.annotate
import bi.atomic.workerdeck.core.LayoutRow
import bi.atomic.workerdeck.core.TranscriptLine
import kotlinx.coroutines.flow.distinctUntilChanged

// Bottom-anchored rows from the core's layout, lines only for the window the core holds. Shared by the session and
// the sub-agent takeover; `rows` is one snapshot, so the key lambda never reads a shorter list than `count`.
@Composable
fun TranscriptList(
    rows: List<LayoutRow>,
    linesAt: (Int) -> List<TranscriptLine>?,
    style: TextStyle,
    lineHeight: TextUnit,
    sidePadding: Dp,
    palette: Palette,
    onVisible: (Int, Int) -> Unit,
    onPress: (Int, Int) -> Unit,
    modifier: Modifier = Modifier,
    jump: Jump? = null,
) {
    val density = LocalDensity.current
    val list = rememberLazyListState()
    val count = rows.size
    LaunchedEffect(list, count) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.map { it.index } }
            .distinctUntilChanged()
            .collect { indices ->
                if (indices.isEmpty() || count == 0) return@collect
                onVisible(count - 1 - indices.max(), count - 1 - indices.min())
            }
    }
    LaunchedEffect(jump) {
        val row = jump?.row ?: return@LaunchedEffect
        if (row < count) list.scrollToItem(count - 1 - row)
    }
    LazyColumn(modifier, state = list, reverseLayout = true) {
        items(count, key = { index -> rows[count - 1 - index].key }) { index ->
            val row = count - 1 - index
            val height = with(density) { rows[row].height.toDp() }
            val lines = linesAt(row)
            if (lines == null) {
                Spacer(Modifier.height(height))
            } else {
                val line = with(density) { lineHeight.toDp() }
                Column(Modifier.fillMaxWidth().height(height), verticalArrangement = Arrangement.Bottom) {
                    lines.forEachIndexed { at, it ->
                        Text(
                            annotate(it, palette),
                            style = style,
                            softWrap = false,
                            maxLines = 1,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(line)
                                .background(palette.band(it.band))
                                .padding(horizontal = sidePadding)
                                .let { modifier -> if (it.pressable) modifier.clickable { onPress(row, at) } else modifier },
                        )
                    }
                }
            }
        }
    }
}
