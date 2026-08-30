import { useState, type ReactNode } from 'react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@workerdeck/ui'
import { ThemeToggle } from './shell/ThemeToggle.tsx'
import {
  getFontSize,
  getTranscriptDensity,
  getTranscriptFont,
  getTranscriptVariant,
  setFontSize,
  setTranscriptDensity,
  setTranscriptFont,
  setTranscriptVariant,
  type TranscriptDensity,
  type TranscriptFont,
  type TranscriptVariant,
} from '@/lib/settings.ts'

/**
 * One reader preference, one select. All of them read their stored value **on
 * open** rather than tracking it live: the panel stamps variant, density and font
 * at mount, and reshaping every row under a reader is not worth the jump.
 */
function PrefSelect<T extends string>({
  label,
  options,
  read,
  write,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  read: () => T
  write: (value: T) => void
  /** For a preference other rows depend on — the variant, which decides whether
   * density and font mean anything at all. */
  onChange?: (value: T) => void
}) {
  const [value, setValue] = useState<T>(read)
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        setValue(next as T)
        write(next as T)
        onChange?.(next as T)
      }}
    >
      <SelectTrigger aria-label={label} className="min-w-40">
        <SelectValue>{options.find((o) => o.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <SelectItemText>{option.label}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A label and nothing else: a box around a list of one-line controls claims they are a thing. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label font-medium tracking-wide text-fg-3 uppercase">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Settings as a dialog, not a destination: these are this browser's preferences,
 * and a modal returns you to what you were doing when you close it.
 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // Held here, not in the select, because the two rows below are only meaningful under `cards`
  // — the terminal theme has one line height and one face by construction, and a control that
  // changes nothing invites you to keep pressing it.
  const [variant, setVariant] = useState<TranscriptVariant>(getTranscriptVariant)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sized to the widest control, not to a reading measure: wider and each label drifts
          away from the select it names. */}
      <DialogContent size="md" className="w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader
          title="Settings"
          description="Preferences held by this browser. What a run defaults to lives on its profile; server policy lives where the gateway runs."
        />
        <DialogBody>
          <div className="flex flex-col gap-6">
            <Section title="Appearance">
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-fg-2">Theme</span>
                <ThemeToggle />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-fg-2">Agent view style</span>
                <PrefSelect<TranscriptVariant>
                  label="Agent view style"
                  options={[
                    { value: 'cards', label: 'Cards' },
                    { value: 'terminal', label: 'Terminal' },
                  ]}
                  read={getTranscriptVariant}
                  write={setTranscriptVariant}
                  onChange={setVariant}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-fg-2">Font size</span>
                <PrefSelect<string>
                  label="Font size"
                  options={[
                    { value: '', label: 'Default' },
                    { value: '11', label: '11 px' },
                    { value: '12', label: '12 px' },
                    { value: '13', label: '13 px' },
                    { value: '14', label: '14 px' },
                    { value: '15', label: '15 px' },
                    { value: '16', label: '16 px' },
                  ]}
                  read={() => String(getFontSize() ?? '')}
                  write={(v) => setFontSize(v ? Number(v) : undefined)}
                />
              </div>
              {variant === 'cards' ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-body-sm text-fg-2">Agent view density</span>
                    <PrefSelect<TranscriptDensity>
                      label="Agent view density"
                      options={[
                        { value: 'comfortable', label: 'Comfortable' },
                        { value: 'compact', label: 'Compact' },
                      ]}
                      read={getTranscriptDensity}
                      write={setTranscriptDensity}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-body-sm text-fg-2">Agent view font</span>
                    <PrefSelect<TranscriptFont>
                      label="Agent view font"
                      options={[
                        { value: 'sans', label: 'Regular' },
                        { value: 'mono', label: 'Monospace' },
                      ]}
                      read={getTranscriptFont}
                      write={setTranscriptFont}
                    />
                  </div>
                </>
              ) : null}
            </Section>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
