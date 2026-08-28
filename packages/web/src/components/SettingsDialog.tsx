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
 * One reader preference, one select.
 *
 * All three read their stored value **on open** rather than tracking it live:
 * the panel stamps variant, density and font at mount, and reshaping every row
 * under someone reading another screen's transcript is not worth the jump.
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
      }}>
      <SelectTrigger aria-label={label} className='min-w-40'>
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

/**
 * A group of rows under a label.
 *
 * A label and nothing else — no card, no border. Every row in this sheet is one
 * control with its name beside it, and a box drawn around a list of those says
 * they are a *thing* when they are only a heading's worth of grouping. The
 * explanations went the same way: a select whose two options are "Cards" and
 * "Terminal" is answered by trying it, not by a paragraph under it.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-3'>
      <h3 className='text-label font-medium tracking-wide text-fg-3 uppercase'>{title}</h3>
      {children}
    </section>
  )
}

/**
 * Settings as a dialog rather than a destination.
 *
 * These are client-side preferences — theme, transcript shape, the defaults the
 * create forms pre-fill — and none of them is somewhere you *work*. A nav entry
 * that replaced the sidebar and the detail pane to show four rows of selects was
 * spending the whole window on a preference sheet; a modal returns you to what
 * you were doing when you close it, which is the only thing anyone wants from
 * this screen.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Held here, not in the select, because two rows below it are only meaningful
  // under `cards` — the terminal theme has one line height and one (monospace)
  // face by construction. A control that changes nothing is worse than an absent
  // one: it invites you to keep pressing it.
  const [variant, setVariant] = useState<TranscriptVariant>(getTranscriptVariant)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column of one-line rows, so it is sized to the widest control rather
          than to a reading measure. Wider than this and each label drifts a
          screen away from the select it names. */}
      <DialogContent size='md' className='w-[min(30rem,calc(100vw-2rem))]'>
        <DialogHeader
          title='Settings'
          description='Preferences held by this browser. What a run defaults to lives on its profile; server policy lives where the gateway runs.'
        />
        <DialogBody>
          <div className='flex flex-col gap-6'>
            <Section title='Appearance'>
              <div className='flex items-center justify-between'>
                <span className='text-body-sm text-fg-2'>Theme</span>
                <ThemeToggle />
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-body-sm text-fg-2'>Agent view style</span>
                <PrefSelect<TranscriptVariant>
                  label='Agent view style'
                  options={[
                    { value: 'cards', label: 'Cards' },
                    { value: 'terminal', label: 'Terminal' },
                  ]}
                  read={getTranscriptVariant}
                  write={setTranscriptVariant}
                  onChange={setVariant}
                />
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-body-sm text-fg-2'>Font size</span>
                <PrefSelect<string>
                  label='Font size'
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
                  <div className='flex items-center justify-between'>
                    <span className='text-body-sm text-fg-2'>Agent view density</span>
                    <PrefSelect<TranscriptDensity>
                      label='Agent view density'
                      options={[
                        { value: 'comfortable', label: 'Comfortable' },
                        { value: 'compact', label: 'Compact' },
                      ]}
                      read={getTranscriptDensity}
                      write={setTranscriptDensity}
                    />
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-body-sm text-fg-2'>Agent view font</span>
                    <PrefSelect<TranscriptFont>
                      label='Agent view font'
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
