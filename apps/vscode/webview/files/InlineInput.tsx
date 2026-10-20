import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

type Validation = { text: string; severity: 'error' | 'warning' } | undefined

type Props = {
  initial: string
  selectExtension: boolean
  validate: (value: string) => Validation
  onCommit: (value: string) => void
  onCancel: () => void
}

export function InlineInput({ initial, selectExtension, validate, onCommit, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const [rect, setRect] = useState<DOMRect | undefined>()
  const done = useRef(false)
  const [forced, setForced] = useState(false)
  const validation = value === initial && !forced ? undefined : validate(value)

  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, selectExtension && dot > 0 ? dot : initial.length)
    setRect(input.parentElement?.parentElement?.getBoundingClientRect())
  }, [initial, selectExtension])

  useEffect(() => {
    const update = () => setRect(inputRef.current?.parentElement?.parentElement?.getBoundingClientRect())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const finish = (commit: boolean) => {
    if (done.current) {
      return
    }
    if (commit && value !== initial && validation?.severity !== 'error') {
      done.current = true
      onCommit(value)
      return
    }
    if (!commit || value === initial || validation?.severity === 'error') {
      done.current = true
      onCancel()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      const verdict = validate(value)
      if (verdict?.severity === 'error') {
        setForced(true)
        return
      }
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  }

  return (
    <>
      <div className="monaco-icon-label-container" style={{ display: 'none' }} />
      <div
        className={`monaco-inputbox idle synthetic-focus${validation ? ` ${validation.severity}` : ''}`}
        style={{
          backgroundColor: 'var(--vscode-input-background)',
          color: 'var(--vscode-input-foreground)',
          border: `1px solid ${validation ? `var(--vscode-inputValidation-${validation.severity}Border)` : 'var(--vscode-input-border, transparent)'}`,
        }}
      >
        <div className="ibwrapper">
          <input
            ref={inputRef}
            className="input"
            type="text"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Type file name. Press Enter to confirm or Escape to cancel."
            value={value}
            style={{ backgroundColor: 'inherit', color: 'var(--vscode-input-foreground)' }}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => finish(true)}
          />
        </div>
      </div>
      {validation && rect ? (
        <div
          className="monaco-inputbox-container"
          style={{ position: 'fixed', top: rect.bottom, left: rect.left, width: rect.width, zIndex: 10 }}
        >
          <span
            className={`monaco-inputbox-message ${validation.severity}`}
            style={{
              backgroundColor: `var(--vscode-inputValidation-${validation.severity}Background)`,
              color: `var(--vscode-inputValidation-${validation.severity}Foreground)`,
              border: `1px solid var(--vscode-inputValidation-${validation.severity}Border)`,
            }}
          >
            {renderBold(validation.text)}
          </span>
        </div>
      ) : null}
    </>
  )
}

function renderBold(text: string) {
  return text.split('**').map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}
