package bi.atomic.workerdeck.app.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.AttachmentChip
import bi.atomic.workerdeck.core.ffi.AttachmentStatus
import bi.atomic.workerdeck.core.ffi.ImagePlan
import bi.atomic.workerdeck.core.ffi.attachmentThumbnailSize
import bi.atomic.workerdeck.core.ffi.imageJpegQuality
import bi.atomic.workerdeck.core.ffi.imagePlan
import bi.atomic.workerdeck.core.ffi.unreadableFile
import java.io.ByteArrayOutputStream

sealed interface PickResult {
    data class Picked(val file: PickedFile) : PickResult

    data class Refused(val message: String) : PickResult
}

// The core decides which bytes go out as picked and which are scaled and re-encoded; this only does the pixels.
object AttachmentReader {
    // Blocking: call off the main thread.
    fun read(resolver: ContentResolver, uri: Uri, refusal: (String) -> String?): PickResult {
        val name = displayName(resolver, uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        val mediaType = resolver.getType(uri)
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        refusal(mediaType)?.let { return PickResult.Refused(it) }
        val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
            ?: return PickResult.Refused(unreadableFile(name))
        val picked = if (mediaType.startsWith("image/")) image(bytes, name, mediaType) else PickedFile(name, mediaType, bytes, null)
        return picked?.let(PickResult::Picked) ?: PickResult.Refused(unreadableFile(name))
    }

    private fun image(bytes: ByteArray, name: String, mediaType: String): PickedFile? {
        val bitmap = runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(bytes)) { decoder, _, _ -> decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
        }.getOrNull() ?: return PickedFile(name, mediaType, bytes, null)
        return when (val plan = imagePlan(name, mediaType, bitmap.width.toUInt(), bitmap.height.toUInt())) {
            ImagePlan.Keep -> PickedFile(name, mediaType, bytes, thumbnail(bitmap))
            is ImagePlan.Jpeg -> {
                val scaled = Bitmap.createScaledBitmap(bitmap, plan.width.toInt(), plan.height.toInt(), true)
                val out = ByteArrayOutputStream()
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, (imageJpegQuality() * 100).toInt(), out)) return null
                PickedFile(plan.name, "image/jpeg", out.toByteArray(), thumbnail(scaled))
            }
        }
    }

    private fun thumbnail(bitmap: Bitmap): ImageBitmap {
        val (w, h) = attachmentThumbnailSize(bitmap.width.toUInt(), bitmap.height.toUInt())
        return Bitmap.createScaledBitmap(bitmap, w.toInt().coerceAtLeast(1), h.toInt().coerceAtLeast(1), true).asImageBitmap()
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()

    fun documentTypes(kinds: List<String>): Array<String> {
        if (kinds.containsAll(listOf("image", "pdf", "text"))) return arrayOf("*/*")
        val types = kinds.mapNotNull {
            when (it) {
                "image" -> "image/*"
                "pdf" -> "application/pdf"
                "text" -> "text/*"
                else -> null
            }
        }
        return if (types.isEmpty()) arrayOf("*/*") else types.toTypedArray()
    }
}

// The staged files above the field: a local thumbnail with the upload's state on top, tap to retry, x to remove.
@Composable
fun AttachmentStrip(chips: List<AttachmentChip>, thumbnails: Map<ULong, ImageBitmap>, onRetry: (ULong) -> Unit, onRemove: (ULong) -> Unit) {
    LazyRow(
        Modifier.fillMaxWidth().height(64.dp),
        contentPadding = PaddingValues(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(chips, key = { it.id.toLong() }) { chip -> AttachmentCell(chip, thumbnails[chip.id], { onRetry(chip.id) }, { onRemove(chip.id) }) }
    }
}

@Composable
private fun AttachmentCell(chip: AttachmentChip, thumbnail: ImageBitmap?, onRetry: () -> Unit, onRemove: () -> Unit) {
    val colors = Wd.colors
    val shape = RoundedCornerShape(8.dp)
    val failed = chip.status is AttachmentStatus.Failed
    Box(Modifier.padding(top = 6.dp, end = 6.dp)) {
        Box(
            Modifier
                .size(54.dp)
                .clip(shape)
                .border(0.5.dp, colors.separator, shape)
                .clickable(enabled = failed, onClick = onRetry)
                .semantics { contentDescription = chip.accessibilityLabel },
            contentAlignment = Alignment.Center,
        ) {
            if (thumbnail != null) {
                Image(thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else {
                Column(Modifier.fillMaxSize().background(colors.raised), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("▤", style = TextStyle(fontFamily = Wd.mono, fontSize = 14.sp, color = colors.secondary))
                    Text(chip.extension, maxLines = 1, style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.SemiBold, color = colors.secondary))
                }
            }
            when (chip.status) {
                AttachmentStatus.Uploading -> Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
                }
                is AttachmentStatus.Failed -> Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                    Text("⚠", style = TextStyle(fontSize = 16.sp, color = colors.orange))
                }
                AttachmentStatus.Ready -> Unit
            }
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset(x = 6.dp, y = (-6).dp)
                .size(20.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.6f))
                .clickable(onClick = onRemove)
                .semantics { contentDescription = "Remove ${chip.name}" },
            contentAlignment = Alignment.Center,
        ) {
            Text("✕", style = TextStyle(fontSize = 10.sp, color = Color.White))
        }
    }
}
