package bi.atomic.workerdeck.app.sessions

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bi.atomic.workerdeck.app.ui.EngineMark
import bi.atomic.workerdeck.app.ui.BadgeGlyph
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.ListRow
import bi.atomic.workerdeck.core.ffi.TrayMember
import bi.atomic.workerdeck.core.ffi.avatarBusyFrame
import bi.atomic.workerdeck.core.ffi.avatarFrameDurations
import bi.atomic.workerdeck.core.ffi.avatarStripWidth

class AvatarFrames(val still: ImageBitmap, val busy: List<ImageBitmap>, val durations: List<Double>)

private val GREYSCALE = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) })

fun decodeAvatar(still: ByteArray, strip: Pair<ByteArray, String?>?): AvatarFrames? {
    val image = BitmapFactory.decodeByteArray(still, 0, still.size) ?: return null
    val durations = strip?.let { avatarFrameDurations(it.second) }.orEmpty()
    val busy = strip?.let { slice(it.first, durations) }.orEmpty()
    return AvatarFrames(image.asImageBitmap(), busy, if (busy.isEmpty()) emptyList() else durations)
}

private fun slice(data: ByteArray, durations: List<Double>): List<ImageBitmap> {
    val image = BitmapFactory.decodeByteArray(data, 0, data.size) ?: return emptyList()
    val width = avatarStripWidth(durations.size.toUInt(), image.width.toUInt())?.toInt() ?: return emptyList()
    return durations.indices.map { Bitmap.createBitmap(image, it * width, 0, width, image.height).asImageBitmap() }
}

@Composable
fun AgentAvatar(row: ListRow, frames: AvatarFrames?, size: Dp) {
    val colors = Wd.colors
    val corner = if (size >= 28.dp) 14.dp else 11.dp
    Box(Modifier.size(size)) {
        when {
            frames == null -> Box(
                Modifier.size(size).drawBehind {
                    val dash = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))
                    val stroke = 1.dp.toPx()
                    drawRoundRect(
                        colors.tertiary,
                        topLeft = Offset(stroke / 2, stroke / 2),
                        size = Size(this.size.width - stroke, this.size.height - stroke),
                        cornerRadius = CornerRadius(4.dp.toPx()),
                        style = Stroke(stroke, pathEffect = dash),
                    )
                },
                contentAlignment = Alignment.Center,
            ) { EngineMark(row.mark, row.markTinted, size = size / 2) }
            row.avatarBusy && frames.busy.isNotEmpty() -> BusyAvatar(frames, size)
            else -> Picture(frames.still, size, row.asleep)
        }
        row.badge?.let { badge ->
            Box(
                Modifier.align(Alignment.BottomEnd).offset(4.dp, 4.dp).size(corner).background(colors.background, CircleShape),
                contentAlignment = Alignment.Center,
            ) { BadgeGlyph(badge, size = corner * 0.72f) }
        }
    }
}

// A tray picture: idle by definition (Auto shows every busy Member as a row), so no badge and no animation.
@Composable
fun TrayAvatar(member: TrayMember, frames: AvatarFrames?, size: Dp) {
    if (frames != null) {
        Picture(frames.still, size, member.asleep)
    } else {
        Box(Modifier.size(size).background(Wd.colors.raised, RoundedCornerShape(4.dp)))
    }
}

@Composable
private fun BusyAvatar(frames: AvatarFrames, size: Dp) {
    var index by remember(frames) { mutableIntStateOf(0) }
    LaunchedEffect(frames) {
        while (true) {
            withFrameMillis { index = avatarBusyFrame(frames.durations, System.currentTimeMillis().toDouble()).toInt() }
        }
    }
    Picture(frames.busy[index.coerceIn(0, frames.busy.lastIndex)], size, asleep = false)
}

@Composable
private fun Picture(image: ImageBitmap, size: Dp, asleep: Boolean) {
    Image(
        image,
        contentDescription = null,
        modifier = Modifier.size(size).clip(RoundedCornerShape(4.dp)),
        contentScale = ContentScale.FillBounds,
        alpha = if (asleep) 0.6f else 1f,
        colorFilter = if (asleep) GREYSCALE else null,
        filterQuality = FilterQuality.None,
    )
}
