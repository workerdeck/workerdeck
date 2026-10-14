package bi.atomic.workerdeck.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// The iOS app's look: system black or white, VS Code blue as the accent, iOS semantic tints for state. Dynamic colour
// stays off, so the app reads the same on every phone and next to the other clients.
@Immutable
data class WdColors(
    val dark: Boolean,
    val background: Color,
    val surface: Color,
    val raised: Color,
    val separator: Color,
    val primary: Color,
    val secondary: Color,
    val tertiary: Color,
    val accent: Color,
    val blue: Color,
    val green: Color,
    val orange: Color,
    val red: Color,
    val purple: Color,
    val coral: Color,
    val openai: Color,
    val badge: Color,
    val palette: Palette,
)

private fun darkColors() = WdColors(
    dark = true,
    background = Color.Black,
    surface = Color(0xFF0B0B0C),
    raised = Color(0xFF1C1C1E),
    separator = Color(0xFF2C2C2E),
    primary = Color.White,
    secondary = Color(0x99EBEBF5),
    tertiary = Color(0x4DEBEBF5),
    accent = Color(0xFF3794FF),
    blue = Color(0xFF0A84FF),
    green = Color(0xFF30D158),
    orange = Color(0xFFFF9F0A),
    red = Color(0xFFFF453A),
    purple = Color(0xFFBF5AF2),
    coral = Color(0xFFD97757),
    openai = Color.White,
    badge = Color(0xFF636366),
    palette = Palette.of(dark = true),
)

private fun lightColors() = WdColors(
    dark = false,
    background = Color.White,
    surface = Color(0xFFF9F9FB),
    raised = Color(0xFFF2F2F7),
    separator = Color(0xFFD1D1D6),
    primary = Color.Black,
    secondary = Color(0x993C3C43),
    tertiary = Color(0x4D3C3C43),
    accent = Color(0xFF0078D4),
    blue = Color(0xFF007AFF),
    green = Color(0xFF34C759),
    orange = Color(0xFFFF9500),
    red = Color(0xFFFF3B30),
    purple = Color(0xFFAF52DE),
    coral = Color(0xFFBF5B3D),
    openai = Color(0xFF373737),
    badge = Color(0xFFAEAEB2),
    palette = Palette.of(dark = false),
)

val LocalWdColors = staticCompositionLocalOf { darkColors() }

object Wd {
    val colors: WdColors
        @Composable get() = LocalWdColors.current

    val mono = FontFamily.Monospace
}

private val typography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun WorkerDeckTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = remember(dark) { if (dark) darkColors() else lightColors() }
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = colors.accent,
        onPrimary = Color.White,
        secondary = colors.accent,
        background = colors.background,
        onBackground = colors.primary,
        surface = colors.background,
        onSurface = colors.primary,
        surfaceVariant = colors.raised,
        onSurfaceVariant = colors.secondary,
        surfaceContainer = colors.raised,
        surfaceContainerHigh = colors.raised,
        surfaceContainerLow = colors.surface,
        outline = colors.separator,
        outlineVariant = colors.separator,
        error = colors.red,
    )
    CompositionLocalProvider(LocalWdColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
