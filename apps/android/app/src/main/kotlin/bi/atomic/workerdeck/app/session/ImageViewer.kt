package bi.atomic.workerdeck.app.session

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

data class ViewedImage(val image: ImageBitmap, val name: String)

val LocalOpenImage = staticCompositionLocalOf<((ViewedImage) -> Unit)?> { null }

private const val MAX_ZOOM = 8f

private val STAGE_PADDING = 16.dp

// Full screen over everything, the web viewer's shape: opens at fit (upscaled, unlike the web: a phone screenshot
// would otherwise open smaller than its transcript box), pinch and drag to inspect,
// double tap toggles fit and a closer look at the tap, Back or the close button leaves.
@Composable
fun ImageViewer(viewed: ViewedImage, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
            val density = LocalDensity.current
            val image = viewed.image
            val pad = with(density) { STAGE_PADDING.toPx() }
            val stageW = with(density) { maxWidth.toPx() }
            val stageH = with(density) { maxHeight.toPx() }
            val fit = minOf((stageW - pad * 2) / image.width, (stageH - pad * 2) / image.height).coerceAtLeast(0.01f)
            val most = maxOf(MAX_ZOOM, fit * 4)
            var scale by remember(viewed) { mutableFloatStateOf(fit) }
            var offset by remember(viewed) { mutableStateOf(Offset.Zero) }
            fun clamp(next: Offset, at: Float): Offset {
                val spareX = maxOf(0f, (image.width * at - stageW) / 2)
                val spareY = maxOf(0f, (image.height * at - stageH) / 2)
                return Offset(next.x.coerceIn(-spareX, spareX), next.y.coerceIn(-spareY, spareY))
            }
            Image(
                image,
                contentDescription = viewed.name,
                contentScale = ContentScale.None,
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(viewed, fit) {
                        detectTapGestures(onDoubleTap = { tap ->
                            val target = if (scale > fit + 0.001f) fit else maxOf(1f, fit * 2.5f).coerceAtMost(most)
                            val center = Offset(stageW / 2, stageH / 2)
                            val focus = (tap - center - offset) / scale
                            scale = target
                            offset = clamp(tap - center - focus * target, target)
                        })
                    }
                    .pointerInput(viewed, fit) {
                        detectTransformGestures { centroid, pan, zoom, _ ->
                            val next = (scale * zoom).coerceIn(fit, most)
                            val center = Offset(stageW / 2, stageH / 2)
                            val focus = (centroid - center - offset) / scale
                            offset = clamp(centroid - center - focus * next + pan, next)
                            scale = next
                        }
                    }
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
            )
            Row(
                Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).statusBarsPadding().padding(start = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    viewed.name,
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "${(scale * 100).toInt()}%",
                    color = Color.White.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.labelMedium,
                )
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "Close", tint = Color.White) }
            }
        }
    }
}
