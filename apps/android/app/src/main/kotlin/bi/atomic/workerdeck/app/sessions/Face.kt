package bi.atomic.workerdeck.app.sessions

import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import bi.atomic.workerdeck.app.ui.Wd
import bi.atomic.workerdeck.core.ffi.FaceMotion
import bi.atomic.workerdeck.core.ffi.FaceMotionKind
import bi.atomic.workerdeck.core.ffi.FaceOp
import bi.atomic.workerdeck.core.ffi.FaceSeg
import bi.atomic.workerdeck.core.ffi.FaceSpec
import bi.atomic.workerdeck.core.ffi.FaceStroke
import bi.atomic.workerdeck.core.ffi.faceDrawing
import bi.atomic.workerdeck.core.ffi.faceMotionTables
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

// Draws the core's face drawing and runs its motions; the shapes, colours and keyframes all come from the core.
@Composable
fun Face(spec: FaceSpec, size: Dp, context: Boolean = false) {
    val dark = Wd.colors.dark
    val drawing = remember(spec, size, dark, context) { faceDrawing(spec, size.value.toDouble(), dark, context) }
    val resolver = LocalContext.current.contentResolver
    val reduceMotion = remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    val moving = !reduceMotion && drawing.ops.any { it is FaceOp.Push && it.group.motions.isNotEmpty() }
    var t by remember(spec.state) { mutableDoubleStateOf(if (moving) 0.0 else -1.0) }
    if (moving) {
        LaunchedEffect(spec.state, drawing) {
            val start = withFrameNanos { it }
            while (true) withFrameNanos {
                val now = (it - start) / 1e9
                if (now - t >= FRAME_SECONDS) t = now
            }
        }
    }
    Canvas(Modifier.size(size).graphicsLayer(alpha = drawing.opacity.toFloat())) {
        scale(this.size.width / 32f, pivot = Offset.Zero) { drawFace(drawing.ops, if (moving) t else -1.0) }
    }
}

private const val FRAME_SECONDS = 1.0 / 30

private object FaceTables {
    val samples: Map<FaceMotionKind, FloatArray> by lazy { faceMotionTables().associate { it.kind to it.samples.toFloatArray() } }
}

private fun DrawScope.drawFace(ops: List<FaceOp>, t: Double) {
    var i = 0
    fun group(alpha: Float) {
        while (i < ops.size) {
            when (val op = ops[i++]) {
                is FaceOp.Pop -> return
                is FaceOp.Push -> {
                    val g = op.group
                    var inner = alpha
                    val motions = if (t >= 0) g.motions.map { sample(it, t) } else emptyList()
                    motions.forEach { inner *= it.second }
                    withTransform({
                        transform(affine(g.transform.map { it.toFloat() }))
                        if (g.clip.isNotEmpty()) {
                            clipPath(Path().apply { g.clip.forEach { c -> addRoundRect(rounded(c.x, c.y, c.width, c.height, c.radius)) } })
                        }
                        motions.forEach { transform(affine(it.first)) }
                    }) { group(inner) }
                }
                is FaceOp.Rect -> {
                    val r = op.rect
                    paint(Path().apply { addRoundRect(rounded(r.x, r.y, r.width, r.height, r.radius)) }, r.fill, r.stroke, alpha * r.opacity.toFloat())
                }
                is FaceOp.Path -> paint(path(op.path.segs), op.path.fill, op.path.stroke, alpha * op.path.opacity.toFloat())
            }
        }
    }
    group(1f)
}

// A motion at `t` seconds into its state: the transform pivots on the motion's origin, like CSS `transform-box: fill-box`.
private fun sample(m: FaceMotion, t: Double): Pair<List<Float>, Float> {
    val identity = listOf(1f, 0f, 0f, 1f, 0f, 0f) to 1f
    val samples = FaceTables.samples[m.kind] ?: return identity
    val local = t - m.delay
    if (samples.size < 12 || m.duration <= 0 || local < 0) return identity
    if (m.iterations > 0u && local >= m.duration * m.iterations.toDouble()) return identity
    var p = (local % m.duration) / m.duration
    if (m.reverse) p = 1 - p
    val n = samples.size / 6
    val f = p * (n - 1)
    val i = min(f.toInt(), n - 2)
    val k = (f - i).toFloat()
    val v = FloatArray(6) { samples[i * 6 + it] + (samples[(i + 1) * 6 + it] - samples[i * 6 + it]) * k }
    val rad = Math.toRadians(v[4].toDouble())
    val (ox, oy) = m.originX.toFloat() to m.originY.toFloat()
    val a = cos(rad).toFloat() * v[2]
    val b = sin(rad).toFloat() * v[2]
    val c = -sin(rad).toFloat() * v[3]
    val d = cos(rad).toFloat() * v[3]
    return listOf(a, b, c, d, ox + v[0] - (a * ox + c * oy), oy + v[1] - (b * ox + d * oy)) to v[5]
}

private fun affine(m: List<Float>) = Matrix(floatArrayOf(m[0], m[1], 0f, 0f, m[2], m[3], 0f, 0f, 0f, 0f, 1f, 0f, m[4], m[5], 0f, 1f))

private fun rounded(x: Double, y: Double, w: Double, h: Double, r: Double): RoundRect {
    val radius = min(r, min(w, h) / 2).toFloat()
    return RoundRect(x.toFloat(), y.toFloat(), (x + w).toFloat(), (y + h).toFloat(), CornerRadius(radius))
}

private fun path(segs: List<FaceSeg>) = Path().apply {
    segs.forEach {
        when (it) {
            is FaceSeg.Move -> moveTo(it.x.toFloat(), it.y.toFloat())
            is FaceSeg.Line -> lineTo(it.x.toFloat(), it.y.toFloat())
            is FaceSeg.Quad -> quadraticTo(it.cx.toFloat(), it.cy.toFloat(), it.x.toFloat(), it.y.toFloat())
            is FaceSeg.Close -> close()
        }
    }
}

private fun DrawScope.paint(shape: Path, fill: UInt?, stroke: FaceStroke?, alpha: Float) {
    fill?.let { drawPath(shape, color(it), alpha = alpha, style = Fill) }
    stroke?.let {
        val style = Stroke(
            width = it.width.toFloat(),
            cap = if (it.roundCap) StrokeCap.Round else StrokeCap.Butt,
            join = if (it.roundJoin) StrokeJoin.Round else StrokeJoin.Miter,
        )
        drawPath(shape, color(it.color), alpha = alpha, style = style)
    }
}

private fun color(argb: UInt): Color {
    val v = argb.toInt()
    return Color((v shr 16 and 0xff) / 255f, (v shr 8 and 0xff) / 255f, (v and 0xff) / 255f, 1f, ColorSpaces.DisplayP3)
}
