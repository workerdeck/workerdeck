package bi.atomic.workerdeck.app.session

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import bi.atomic.workerdeck.core.LineImage
import bi.atomic.workerdeck.core.ffi.resultImagePath
import java.util.Collections
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

sealed interface ImageState {
    data object Pending : ImageState

    data object Failed : ImageState

    data class Loaded(val image: ImageBitmap) : ImageState
}

// A tool result's pictures arrive as refs; the bytes are fetched once, by the box the reader scrolled to. Decoded
// bitmaps stay in an LRU so a scroll back does not refetch; a failure (a stale seq 404s) stays failed, so the box
// settles on "image unavailable" instead of retrying on every pass. Every state keeps the box's height.
class ToolImages(private val sessionId: String, private val fetch: suspend (String) -> ByteArray?) {
    private val cache = object : LruCache<String, ImageBitmap>(BUDGET_BYTES) {
        override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
    }
    private val failed = Collections.synchronizedSet(mutableSetOf<String>())

    fun path(image: LineImage) = resultImagePath(sessionId, image.sourceSeq, image.toolUseId, image.partIndex)

    fun peek(image: LineImage): ImageState {
        val path = path(image)
        cache.get(path)?.let { return ImageState.Loaded(it) }
        return if (path in failed) ImageState.Failed else ImageState.Pending
    }

    suspend fun load(image: LineImage): ImageState {
        peek(image).takeIf { it != ImageState.Pending }?.let { return it }
        val path = path(image)
        val bitmap = fetch(path)?.let { bytes ->
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }
        if (bitmap == null) {
            failed.add(path)
            return ImageState.Failed
        }
        cache.put(path, bitmap)
        return ImageState.Loaded(bitmap)
    }

    private companion object {
        const val BUDGET_BYTES = 64 * 1024 * 1024
    }
}

val LocalToolImages = staticCompositionLocalOf<ToolImages?> { null }

// The settle delay is the web's: a row flung past does not start a fetch, and leaving cancels one in flight.
@Composable
fun rememberImageState(image: LineImage): ImageState {
    val images = LocalToolImages.current
    var state by remember(images, image) { mutableStateOf(images?.peek(image) ?: ImageState.Pending) }
    LaunchedEffect(images, image) {
        if (images == null || state != ImageState.Pending) return@LaunchedEffect
        delay(MOUNT_SETTLE_MS)
        state = images.load(image)
    }
    return state
}

private const val MOUNT_SETTLE_MS = 150L
