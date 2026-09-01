'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Segment, TriggerConfig, ActiveTrigger, TriggerSuggestion, ChipSegment } from './types.ts'
import { segmentsToPlainText } from './prompt-area-engine.ts'
import {
  isChipElement,
  isLinkElement,
  chipNodeToSegment,
  indexOfChildNode,
  domChildIndexToSegmentIndex,
  safeJsonStringify,
} from './dom-helpers.ts'
import { setCursorAtOffset } from './cursor-helpers.ts'

type UseChipEditingOptions = {
  editorRef: React.RefObject<HTMLDivElement | null>
  triggers: TriggerConfig[]
  disabled: boolean
  onChange: (segments: Segment[]) => void
  renderSegmentsToDOM: (segments: Segment[]) => void
  onChipClick?: (chip: ChipSegment) => void
  onChipAdd?: (chip: ChipSegment) => void
  onChipDelete?: (chip: ChipSegment) => void
  onLinkClick?: (url: string) => void
  setActiveTrigger: React.Dispatch<React.SetStateAction<ActiveTrigger | null>>
  setSelectedSuggestionIndex: React.Dispatch<React.SetStateAction<number>>
  setTriggerRect: React.Dispatch<React.SetStateAction<DOMRect | null>>
  runSearch: (query: string, config: TriggerConfig) => void
  activeTrigger: ActiveTrigger | null
  suggestions: TriggerSuggestion[]
}

type UseChipEditingReturn = {
  handleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  /** Forget the clicked chip: typing or a dismiss supersedes the chip-click dropdown. */
  clear: () => void
  /**
   * The `reopenOnChipClick` selection path: when a chip-click dropdown is open, replace the
   * clicked chip in place and return true (the caller dismisses and refocuses); return false
   * when no chip edit is in flight so the caller resolves typed trigger text as usual.
   * `pushUndo` arrives per call because the undo stack lives in usePromptAreaEvents, which is
   * wired up after this hook.
   */
  trySelectEditingChip: (
    segments: Segment[],
    chipData: Omit<ChipSegment, 'type' | 'trigger'>,
    triggerChar: string,
    pushUndo: (segments: Segment[]) => void,
  ) => boolean
}

// The chip-click editing path (`reopenOnChipClick`), moved whole from use-prompt-area.ts:
// the three refs and their anti-loop choreography, the mousedown/click delegation, and the
// re-verify-on-select recovery.
export function useChipEditing({
  editorRef,
  triggers,
  disabled,
  onChange,
  renderSegmentsToDOM,
  onChipClick,
  onChipAdd,
  onChipDelete,
  onLinkClick,
  setActiveTrigger,
  setSelectedSuggestionIndex,
  setTriggerRect,
  runSearch,
  activeTrigger,
  suggestions,
}: UseChipEditingOptions): UseChipEditingReturn {
  // Chip whose dropdown was reopened via `reopenOnChipClick`: while set, the active
  // dropdown edits this chip in place instead of resolving typed text. `segIndex` is
  // the segment index at CLICK time, not the DOM node, which can detach if
  // `renderSegmentsToDOM` re-renders while the dropdown is open; selection re-verifies
  // it and falls back to a trigger+value search if the model shifted underneath.
  const editingChip = useRef<{ chip: ChipSegment; segIndex: number } | null>(null)

  // The chip node currently edited via `reopenOnChipClick`, kept in lockstep with
  // `editingChip`/`activeTrigger`. Answers "is THIS exact element the open one" by
  // reference identity — trigger+value cannot distinguish two chips sharing a value.
  const openChipNode = useRef<HTMLElement | null>(null)

  // Set by `handleMouseDown` when the mousedown landed on `openChipNode.current`;
  // read and cleared by the following `handleClick` to tell "reopen" from
  // "toggle closed". A real mousedown on the editor root rather than a
  // `dismissTrigger` flag: bubbling reaches the root before `document`, where
  // TriggerPopover's outside-click dismiss listens and would clear `openChipNode`
  // first — and it stays scoped to this node, so an unrelated dismiss cannot poison
  // a later click on the same chip.
  const suppressReopenChip = useRef<HTMLElement | null>(null)

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target
      if (!(target instanceof Node)) {
        return
      }

      const editor = editorRef.current
      if (!editor) {
        return
      }

      let node: Node | null = target
      while (node && node !== editor) {
        // Check for URL link click — only navigate on Cmd/Ctrl+Click;
        // plain click just positions the cursor for editing.
        if (isLinkElement(node)) {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            onLinkClick?.(node.href)
            window.open(node.href, '_blank', 'noopener,noreferrer')
            return
          }
          // Plain click: let the browser place the cursor inside the link text
          break
        }

        if (isChipElement(node)) {
          // Spawn ripple effect. `isChipElement` has already narrowed `node`
          // to HTMLElement, so no cast is needed.
          const rect = node.getBoundingClientRect()
          const ripple = document.createElement('span')
          ripple.className = 'prompt-area-chip-ripple'
          const size = Math.max(rect.width, rect.height)
          ripple.style.width = `${size}px`
          ripple.style.height = `${size}px`
          ripple.style.left = `${e.clientX - rect.left - size / 2}px`
          ripple.style.top = `${e.clientY - rect.top - size / 2}px`
          node.appendChild(ripple)
          ripple.addEventListener('animationend', () => ripple.remove())

          const chip = chipNodeToSegment(node)
          if (chip) {
            // Native chip-click dropdown: reopen this trigger's suggestions
            // anchored to the chip so the selection can replace it in place.
            // Gated on `!disabled` — a disabled composer must not accept edits
            // through any path, including this one.
            const config = triggers.find((t) => t.char === chip.trigger)
            // A click on THIS exact chip element while its own dropdown was
            // open just closed it (see `suppressReopenChip` and
            // `handleMouseDown`) — treat that as a toggle-close, not a reopen.
            const wasOpenForThisChip = suppressReopenChip.current === node
            suppressReopenChip.current = null
            if (!disabled && !wasOpenForThisChip && config?.reopenOnChipClick && config.mode === 'dropdown' && config.onSearch) {
              const childIdx = indexOfChildNode(editor, node)
              editingChip.current = {
                chip,
                segIndex: domChildIndexToSegmentIndex(editor, childIdx),
              }
              openChipNode.current = node
              setActiveTrigger({ config, startOffset: 0, query: '' })
              setSelectedSuggestionIndex(0)
              setTriggerRect(rect)
              runSearch('', config)
            }
            onChipClick?.(chip)
          }
          return
        }
        node = node.parentNode
      }
    },
    [onChipClick, onLinkClick, triggers, runSearch, disabled],
  )

  // Feeds `suppressReopenChip` for handleClick's toggle-close detection.

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target
    const editor = editorRef.current
    if (!editor || !(target instanceof Node)) {
      suppressReopenChip.current = null
      return
    }

    let node: Node | null = target
    while (node && node !== editor) {
      if (isChipElement(node)) {
        suppressReopenChip.current = openChipNode.current === node ? node : null
        return
      }
      node = node.parentNode
    }
    suppressReopenChip.current = null
  }, [])

  // Select a suggestion from the dropdown

  const clear = useCallback(() => {
    editingChip.current = null
    openChipNode.current = null
  }, [])

  // Chip-click dropdown (`reopenOnChipClick`): replace the clicked chip in
  // place instead of resolving typed trigger text at the caret. Disabled
  // is re-checked here (not just at open time) in case the composer
  // became disabled while the popover was still open.
  const trySelectEditingChip = useCallback(
    (
      segments: Segment[],
      chipData: Omit<ChipSegment, 'type' | 'trigger'>,
      triggerChar: string,
      pushUndo: (segments: Segment[]) => void,
    ): boolean => {
      const editing = editingChip.current
      if (!editing) {
        return false
      }
      const editor = editorRef.current
      if (editor && !disabled) {
        // Re-verify the click-time index still holds the same chip — the
        // model may have shifted (external value update, undo/redo) while
        // the dropdown was open. If it moved, recover ONLY when exactly one
        // chip in the document now matches trigger+value: with duplicates,
        // guessing risks silently editing the wrong instance, which is
        // worse than the no-op this falls back to.
        const atIndex = segments[editing.segIndex]
        const stillThere = atIndex?.type === 'chip' && atIndex.trigger === editing.chip.trigger && atIndex.value === editing.chip.value
        const segIdx = stillThere
          ? editing.segIndex
          : (() => {
              const matches: number[] = []
              segments.forEach((seg, i) => {
                if (seg.type === 'chip' && seg.trigger === editing.chip.trigger && seg.value === editing.chip.value) {
                  matches.push(i)
                }
              })
              return matches.length === 1 ? matches[0] : -1
            })()
        const oldChip = segIdx !== -1 ? segments[segIdx] : undefined

        if (oldChip?.type === 'chip') {
          const newChip: ChipSegment = {
            type: 'chip',
            trigger: triggerChar,
            ...chipData,
          }
          let newSegments = segments.map((seg, i) => (i === segIdx ? newChip : seg))

          // Guarantee a real landing spot after the replaced chip, mirroring
          // resolveChip's trailing-space convention (prompt-area-engine.ts):
          // if the new chip is now the last segment (or directly followed by
          // another chip), the caret would land at a bare element boundary
          // with no text node, which some engines fail to render/snap a
          // visible caret at.
          const nextSeg = newSegments[segIdx + 1]
          const insertedSpace = !nextSeg || nextSeg.type !== 'text' || nextSeg.text.length === 0
          if (insertedSpace) {
            newSegments = [...newSegments.slice(0, segIdx + 1), { type: 'text', text: ' ' }, ...newSegments.slice(segIdx + 1)]
          }

          pushUndo(segments)
          onChange(newSegments)
          renderSegmentsToDOM(newSegments)

          // Same value + display text + data: treat as a no-op confirmation
          // rather than a destructive delete+add — onChipDelete is
          // documented as firing on backspace/forward-delete, not on
          // re-confirming the already-selected suggestion.
          const unchanged =
            oldChip.value === newChip.value &&
            oldChip.displayText === newChip.displayText &&
            safeJsonStringify(oldChip.data) === safeJsonStringify(newChip.data)
          if (!unchanged) {
            onChipDelete?.(oldChip)
            onChipAdd?.(newChip)
          }

          // +1 when a space was inserted, matching resolveChip's own
          // "+1 accounts for the trailing space after the chip" placement —
          // landing exactly at the chip's end would put the caret at the
          // same bare element boundary the inserted space exists to avoid.
          const caretOffset = segmentsToPlainText(newSegments.slice(0, segIdx + 1)).length + (insertedSpace ? 1 : 0)
          setCursorAtOffset(editor, caretOffset)
        }
      }
      return true
    },
    [disabled, onChange, renderSegmentsToDOM, onChipAdd, onChipDelete],
  )

  // Chip-click dropdown: once the empty-query suggestions arrive, preselect
  // the chip's current value so the list opens "on" the existing choice.
  useEffect(() => {
    const editing = editingChip.current
    if (!editing || !activeTrigger?.config.reopenOnChipClick) {
      return
    }
    const idx = suggestions.findIndex((s) => s.value === editing.chip.value)
    if (idx > 0) {
      setSelectedSuggestionIndex(idx)
    }
  }, [suggestions, activeTrigger])

  // Memoized so consumers can put the hook's result in dependency arrays without
  // re-creating their callbacks every render.
  return useMemo(
    () => ({ handleClick, handleMouseDown, clear, trySelectEditingChip }),
    [handleClick, handleMouseDown, clear, trySelectEditingChip],
  )
}
