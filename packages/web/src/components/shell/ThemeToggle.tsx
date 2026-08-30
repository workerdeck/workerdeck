import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@workerdeck/ui'
import { getTheme, toggleTheme, type Theme } from '@/lib/theme.ts'

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getTheme())
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => setThemeState(toggleTheme())}>
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
