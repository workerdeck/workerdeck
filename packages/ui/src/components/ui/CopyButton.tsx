import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type ButtonProps } from './Button.tsx'
import { copyText } from '../../lib/clipboard.ts'
import { cn } from '../../lib/utils.ts'

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  value: string
}

export function CopyButton({ value, className, variant = 'ghost', size = 'icon-sm', ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant={variant}
      size={size}
      aria-label='Copy'
      className={cn('text-fg-3', className)}
      onClick={() => {
        // Through `copyText`, which falls back for insecure origins — the
        // dashboard on a LAN address has no `navigator.clipboard` at all, and
        // reaching straight for `.writeText` there throws.
        void copyText(value).then((ok) => {
          // Only tick when it really copied: a check mark over an empty
          // clipboard is worse than no feedback.
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      {...props}>
      {copied ? <Check className='size-3.5 text-success' /> : <Copy className='size-3.5' />}
    </Button>
  )
}
