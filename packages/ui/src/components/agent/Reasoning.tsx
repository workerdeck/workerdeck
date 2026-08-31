import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Response } from './Response.tsx'

export interface ReasoningProps {
  children: string
  isStreaming?: boolean
  defaultOpen?: boolean
  className?: string
}

export function Reasoning({ children, isStreaming = false, defaultOpen, className }: ReasoningProps) {
  const [open, setOpen] = useState(defaultOpen ?? isStreaming)
  const userToggled = useRef(false)

  useEffect(() => {
    if (userToggled.current) {
      return
    }
    if (isStreaming) {
      setOpen(true)
    } else {
      const timer = setTimeout(() => setOpen(false), 600)
      return () => clearTimeout(timer)
    }
  }, [isStreaming])

  const hasText = children.trim() !== ''
  if (!hasText && !isStreaming) {
    return null
  }

  return (
    <div data-slot="reasoning" data-streaming={isStreaming || undefined} className={cn('w-full', className)}>
      <button
        type="button"
        disabled={!hasText}
        onClick={() => {
          userToggled.current = true
          setOpen((v) => !v)
        }}
        className="flex items-center gap-1.5 text-label text-fg-3 transition-colors outline-none disabled:cursor-default hover:text-fg-1 disabled:hover:text-fg-3"
      >
        <Brain className="size-3.5" />
        <span>{isStreaming ? 'Thinking…' : 'Thought process'}</span>
        {hasText ? <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} /> : null}
      </button>
      {open && hasText ? (
        <div className="mt-2 border-l-2 border-border pl-3 text-body-sm text-fg-3 [&_*]:text-fg-3">
          <Response streaming={isStreaming}>{children}</Response>
        </div>
      ) : null}
    </div>
  )
}
