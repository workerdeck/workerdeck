import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type ButtonProps } from './Button.tsx'
import { copyText } from '../../lib/clipboard.ts'
import { cn } from '../../lib/utils.ts'

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  value: string
  glyph?: boolean
}

export function CopyButton({ value, glyph, className, variant = 'ghost', size = 'icon-sm', ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant={variant}
      size={size}
      aria-label="Copy"
      className={cn('text-fg-3', className)}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) {
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      {...props}
    >
      {glyph ? (
        <span className={cn('font-mono text-body-sm leading-5', copied && 'text-success')}>{copied ? '✓' : '⧉'}</span>
      ) : copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  )
}
