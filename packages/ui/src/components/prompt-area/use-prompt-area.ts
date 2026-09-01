'use client'

import { cn } from '../../lib/utils.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Segment, TriggerConfig, ActiveTrigger, TriggerSuggestion, ChipSegment, PromptAreaHandle } from './types.ts'
import {
  detectActiveTrigger,
  segmentsToPlainText,
  plainTextToSegments,
  segmentsEqual,
  resolveChip,
  resolveText,
  truncateSegmentsToLength,
} from './prompt-area-engine.ts'
import {
  autoFormatListPrefix,
  normalizeListPrefixes,
  renumberOrderedListSegments,
  remapOffset,
  hasOrderedListRun,
} from './prompt-area-list-ops.ts'
import {
  isHTMLElement,
  isChipElement,
  isBRElement,
  chipNodeToSegment,
  normalizeEditorDOM,
  decorateEditor,
  safeJsonStringify,
} from './dom-helpers.ts'
import {
  saveCursorPosition,
  restoreCursorPosition,
  getCursorOffset,
  setCursorAtOffset,
  createRangeAtOffset,
  getSelectionOffsets,
  setSelectionAtOffsets,
} from './cursor-helpers.ts'
import { usePromptAreaEvents } from './use-prompt-area-events.ts'
import { usePromptAreaKeydown } from './use-prompt-area-keydown.ts'
import { useChipEditing } from './use-chip-editing.ts'
import { useTriggerSearch } from './use-trigger-search.ts'

type UsePromptAreaOptions = {
  value: Segment[]
  onChange: (segments: Segment[]) => void
  triggers?: TriggerConfig[]
  disabled?: boolean
  onSubmit?: (segments: Segment[]) => void
  onEscape?: () => void
  onChipClick?: (chip: ChipSegment) => void
  onChipAdd?: (chip: ChipSegment) => void
  onChipDelete?: (chip: ChipSegment) => void
  onLinkClick?: (url: string) => void
  onPaste?: (data: { segments: Segment[]; source: 'internal' | 'external' }) => void
  onRawPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void
  onUndo?: (segments: Segment[]) => void
  onRedo?: (segments: Segment[]) => void
  onImagePaste?: (file: File) => void
  markdown?: boolean
  normalizeBullets?: boolean
  submitOnEnter?: boolean
  maxLength?: number
}

type UsePromptAreaReturn = {
  editorRef: React.RefObject<HTMLDivElement | null>
  activeTrigger: ActiveTrigger | null
  suggestions: TriggerSuggestion[]
  suggestionsLoading: boolean
  suggestionsError: string | null
  selectedSuggestionIndex: number
  handleInput: () => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  handleClick: (e: React.MouseEvent<HTMLDivElement>) => void
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  selectSuggestion: (suggestion: TriggerSuggestion) => void
  dismissTrigger: () => void
  handle: PromptAreaHandle
  triggerRect: DOMRect | null
  eventHandlers: {
    onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void
    onCopy: (e: React.ClipboardEvent<HTMLDivElement>) => void
    onCut: (e: React.ClipboardEvent<HTMLDivElement>) => void
    onDrop: (e: React.DragEvent<HTMLDivElement>) => void
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
    onCompositionStart: () => void
    onCompositionEnd: () => void
    onBlur: () => void
  }
}

/** Debounce interval for grouping typed characters into a single undo snapshot */
const UNDO_DEBOUNCE_MS = 300

export function usePromptArea({
  value,
  onChange,
  triggers = [],
  disabled = false,
  onSubmit,
  onEscape,
  onChipClick,
  onChipAdd,
  onChipDelete,
  onLinkClick,
  onPaste,
  onRawPaste,
  onUndo,
  onRedo,
  onImagePaste,
  markdown: markdownEnabled = true,
  normalizeBullets = true,
  submitOnEnter = true,
  maxLength,
}: UsePromptAreaOptions): UsePromptAreaReturn {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(null)
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null)

  const { suggestions, suggestionsLoading, suggestionsError, search: runSearch, reset: resetSearch } = useTriggerSearch()

  // Guard against circular DOM <-> model syncs
  const isSyncing = useRef(false)
  const lastRenderedValue = useRef<Segment[]>([])

  // Debounced undo: groups consecutive keystrokes into a single undo snapshot
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const undoBaseState = useRef<Segment[] | null>(null)

  // DOM -> Model: read segments from the contentEditable DOM

  const readSegmentsFromDOM = useCallback((): Segment[] => {
    const editor = editorRef.current
    if (!editor) {
      return []
    }

    const segments: Segment[] = []
    // Track whether the editor holds any real content (text/chip) or a sentinel
    // <br> that renderSegmentsToDOM added. When it holds neither, any <br> nodes
    // present are the browser's filler <br> (see the empty-editor check below).
    let hasRealContent = false
    let hasSentinel = false

    for (let i = 0; i < editor.childNodes.length; i++) {
      const node = editor.childNodes[i]

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ''
        if (text) {
          segments.push({ type: 'text', text })
          hasRealContent = true
        }
      } else if (isChipElement(node)) {
        const chip = chipNodeToSegment(node)
        if (chip) {
          segments.push(chip)
          hasRealContent = true
        }
      } else if (isBRElement(node)) {
        if (node.dataset.sentinel) {
          hasSentinel = true
          continue // skip sentinel <br>
        }
        segments.push({ type: 'text', text: '\n' })
      } else if (isHTMLElement(node)) {
        const text = node.textContent ?? ''
        if (text) {
          segments.push({ type: 'text', text })
          hasRealContent = true
        }
      }
    }

    // An emptied editor keeps a lone browser filler <br>; reading it as "\n" would
    // make `value` permanently non-empty and hide the placeholder forever. A newline
    // we rendered always carries surrounding content or a trailing sentinel <br>, so
    // with neither present every <br> is filler and the editor is genuinely empty.
    if (!hasRealContent && !hasSentinel) {
      return []
    }

    return segments
  }, [])

  // Model -> DOM: render segments into the contentEditable div

  const renderSegmentsToDOM = useCallback(
    (segments: Segment[]) => {
      const editor = editorRef.current
      if (!editor) {
        return
      }

      isSyncing.current = true

      const savedCursor = saveCursorPosition(editor)

      // Clear DOM safely (no innerHTML assignment)
      while (editor.firstChild) {
        editor.removeChild(editor.firstChild)
      }

      for (const seg of segments) {
        if (seg.type === 'text') {
          const lines = seg.text.split('\n')
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            if (lines[lineIdx]) {
              editor.appendChild(document.createTextNode(lines[lineIdx]))
            }
            if (lineIdx < lines.length - 1) {
              editor.appendChild(document.createElement('br'))
            }
          }
        } else {
          const chip = document.createElement('span')
          chip.contentEditable = 'false'
          chip.dataset.chipTrigger = seg.trigger
          chip.dataset.chipValue = seg.value
          chip.dataset.chipDisplay = seg.displayText
          if (seg.data !== undefined) {
            const json = safeJsonStringify(seg.data)
            if (json) {
              chip.dataset.chipData = json
            }
          }
          if (seg.autoResolved) {
            chip.dataset.chipAutoResolved = 'true'
          }
          const triggerConfig = triggers.find((t) => t.char === seg.trigger)
          const chipStyle = triggerConfig?.chipStyle ?? 'pill'
          chip.dataset.chipStyle = chipStyle
          chip.className = cn('prompt-area-chip', chipStyle === 'inline' && 'prompt-area-chip--inline', triggerConfig?.chipClassName)
          chip.textContent = `${seg.trigger}${seg.displayText}`
          chip.setAttribute('role', 'button')
          chip.setAttribute('tabindex', '-1')
          editor.appendChild(chip)
        }
      }

      // Append sentinel <br> so trailing newlines are visible in contentEditable
      if (editor.lastChild && isBRElement(editor.lastChild)) {
        const sentinel = document.createElement('br')
        sentinel.dataset.sentinel = 'true'
        editor.appendChild(sentinel)
      }

      // Decorate URLs, markdown formatting, and list bullets in text nodes
      decorateEditor(editor, markdownEnabled)

      if (savedCursor) {
        restoreCursorPosition(editor, savedCursor)
      }

      lastRenderedValue.current = segments
      isSyncing.current = false
    },
    [triggers, markdownEnabled],
  )

  // The chip-click editing path (`reopenOnChipClick`) lives in use-chip-editing.ts.

  const chipEditing = useChipEditing({
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
  })

  // Trigger detection (extracted so events module can call it)

  // Builds the insertChip handed to callback/launch activations: replaces the
  // trigger's range with a chip and notifies onChipAdd.
  const buildInsertChip = useCallback(
    (segments: Segment[], trigger: ActiveTrigger) => (chip: Omit<ChipSegment, 'type'>) => {
      const chipResult = resolveChip(segments, trigger, {
        value: chip.value,
        displayText: chip.displayText,
        data: chip.data,
      })
      onChange(chipResult.segments)
      renderSegmentsToDOM(chipResult.segments)
      onChipAdd?.({
        type: 'chip',
        trigger: trigger.config.char,
        value: chip.value,
        displayText: chip.displayText,
        ...(chip.data !== undefined ? { data: chip.data } : {}),
      })
      const editor = editorRef.current
      if (editor) {
        setCursorAtOffset(editor, chipResult.cursorOffset)
      }
    },
    [onChange, renderSegmentsToDOM, onChipAdd],
  )

  const runTriggerDetection = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }

    const segments = readSegmentsFromDOM()
    const plainText = segmentsToPlainText(segments)
    const cursorPos = getCursorOffset(editor)

    if (cursorPos === null) {
      return
    }

    const detected = detectActiveTrigger(plainText, cursorPos, triggers)

    // Typing supersedes a chip-click dropdown: whichever branch we take next,
    // the popover no longer edits the clicked chip.
    chipEditing.clear()

    if (detected) {
      setActiveTrigger(detected)
      setSelectedSuggestionIndex(0)

      // Position the popover at the trigger character, not the cursor.
      // Build a range at detected.startOffset so the dropdown anchors to
      // the trigger char even when the cursor has moved past it.
      const triggerRange = createRangeAtOffset(editor, detected.startOffset)
      if (triggerRange) {
        const rect = triggerRange.getBoundingClientRect()
        // A zero rect means the range couldn't be mapped (e.g. after DOM
        // re-render). Skip updating triggerRect so we keep the last valid one.
        if (rect.height > 0 || rect.left > 0 || rect.top > 0) {
          setTriggerRect(rect)
        }
      }

      if (detected.config.mode === 'dropdown' && detected.config.onSearch) {
        runSearch(detected.query, detected.config)
      }

      if (detected.config.mode === 'callback' && detected.config.onActivate) {
        detected.config.onActivate({
          text: plainText,
          cursorPosition: cursorPos,
          insertChip: buildInsertChip(segments, detected),
        })
      }
    } else {
      setActiveTrigger(null)
      resetSearch()
    }
  }, [triggers, readSegmentsFromDOM, buildInsertChip, resetSearch, runSearch, chipEditing])

  // Dismiss trigger

  const dismissTrigger = useCallback(() => {
    chipEditing.clear()
    setActiveTrigger(null)
    setSelectedSuggestionIndex(0)
    resetSearch()
  }, [resetSearch, chipEditing])

  // Wire up edge-case event handlers

  const events = usePromptAreaEvents({
    editorRef,
    readSegmentsFromDOM,
    onChange,
    renderSegmentsToDOM,
    runTriggerDetection,
    dismissTrigger,
    triggers,
    markdownEnabled,
    normalizeBullets,
    onPaste,
    onRawPaste,
    onUndo,
    onRedo,
    onChipAdd,
    onImagePaste,
  })

  // Sync value prop -> DOM on external changes

  useEffect(() => {
    if (isSyncing.current) {
      return
    }
    if (segmentsEqual(value, lastRenderedValue.current)) {
      return
    }

    // Normalize list prefixes (e.g., "- " → "• " when markdown is on)
    // so externally-provided segments render bullet characters correctly.
    if (markdownEnabled && normalizeBullets) {
      const normalized = normalizeListPrefixes(value, true)
      if (normalized !== value) {
        onChange(normalized)
        return // onChange will trigger a re-render with the normalized value
      }
    }

    renderSegmentsToDOM(value)
  }, [value, renderSegmentsToDOM, markdownEnabled, normalizeBullets, onChange])

  // Re-render when markdown mode changes to apply/strip decorations
  // Also convert bullet characters: • ↔ - in text segments
  const prevMarkdown = useRef(markdownEnabled)
  useEffect(() => {
    if (prevMarkdown.current === markdownEnabled) {
      return
    }
    prevMarkdown.current = markdownEnabled

    const converted = normalizeBullets ? normalizeListPrefixes(value, markdownEnabled) : value
    if (converted !== value) {
      onChange(converted)
    } else {
      renderSegmentsToDOM(value)
    }
  }, [markdownEnabled, normalizeBullets, renderSegmentsToDOM, value, onChange])

  // Clean up undo debounce timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimer.current) {
        clearTimeout(undoTimer.current)
      }
    }
  }, [])

  // Handle input events

  const handleInput = useCallback(() => {
    if (isSyncing.current) {
      return
    }

    // During IME composition, sync model but skip trigger detection
    if (events.isComposing.current) {
      const segments = readSegmentsFromDOM()
      lastRenderedValue.current = segments
      onChange(segments)
      return
    }

    const editor = editorRef.current

    // Capture cursor offset BEFORE normalizeEditorDOM strips <a> elements,
    // otherwise the anchor node becomes detached and we lose the position.
    const savedCursorOffset = editor ? getCursorOffset(editor) : null

    if (editor) {
      // Normalize browser-inserted block elements (div, p, font, a, etc.)
      normalizeEditorDOM(editor)
    }

    const segments = readSegmentsFromDOM()

    // Enforce maxLength: if the edit pushed the editor past the cap, truncate
    // back to maxLength characters and keep the caret where the user was
    // editing (clamped to the cap) rather than forcing it to the end.
    if (maxLength != null && editor && segmentsToPlainText(segments).length > maxLength) {
      const caret = getCursorOffset(editor)
      const truncated = truncateSegmentsToLength(segments, maxLength)
      lastRenderedValue.current = truncated
      onChange(truncated)
      renderSegmentsToDOM(truncated)
      setCursorAtOffset(editor, caret != null ? Math.min(caret, maxLength) : maxLength)
      runTriggerDetection()
      return
    }

    // Check for list auto-formatting (e.g., "- " -> "bullet ")
    if (markdownEnabled && normalizeBullets && editor && savedCursorOffset !== null) {
      const formatted = autoFormatListPrefix(segments, savedCursorOffset)
      if (formatted) {
        lastRenderedValue.current = formatted.segments
        onChange(formatted.segments)
        renderSegmentsToDOM(formatted.segments)
        setCursorAtOffset(editor, formatted.cursorOffset)
        runTriggerDetection()
        return
      }
    }

    // Native structural edits (e.g. a Backspace that deleted or merged a list
    // row) bypass applyEditResult, so rebuild ordered-list numbering here too.
    // handleInput fires on every keystroke, so gate on a genuine ordered-list
    // run — this renumbers a real list (1,2,4 → 1,2,3) but leaves incidental
    // numeric prose ("1985. Born / 2020. Died") untouched.
    let nextSegments = segments
    let renumberedCursor: number | null = null
    if (markdownEnabled && savedCursorOffset !== null && hasOrderedListRun(segmentsToPlainText(segments))) {
      const renumbered = renumberOrderedListSegments(segments)
      if (renumbered.edits.length > 0) {
        nextSegments = renumbered.segments
        renumberedCursor = remapOffset(savedCursorOffset, renumbered.edits)
      }
    }

    // Debounced undo: capture the pre-edit state at the start of a typing
    // session and push it to the undo stack after UNDO_DEBOUNCE_MS of idle.
    if (!undoBaseState.current) {
      undoBaseState.current = lastRenderedValue.current
    }

    lastRenderedValue.current = nextSegments
    onChange(nextSegments)
    if (undoTimer.current) {
      clearTimeout(undoTimer.current)
    }
    undoTimer.current = setTimeout(() => {
      if (undoBaseState.current) {
        events.pushUndo(undoBaseState.current)
        undoBaseState.current = null
      }
      undoTimer.current = null
    }, UNDO_DEBOUNCE_MS)

    // Apply the recomputed model to the DOM. A renumber rewrites text nodes, so
    // it needs a full re-render (which also re-decorates); otherwise just
    // re-decorate the existing DOM in place.
    if (editor) {
      if (renumberedCursor !== null) {
        renderSegmentsToDOM(nextSegments)
        setCursorAtOffset(editor, renumberedCursor)
      } else {
        decorateEditor(editor, markdownEnabled)
        if (savedCursorOffset !== null) {
          setCursorAtOffset(editor, savedCursorOffset)
        }
      }
    }

    runTriggerDetection()
  }, [onChange, readSegmentsFromDOM, runTriggerDetection, renderSegmentsToDOM, markdownEnabled, normalizeBullets, maxLength, events])

  const selectSuggestionInternal = useCallback(
    (suggestion: TriggerSuggestion) => {
      if (!activeTrigger) {
        return
      }

      const segments = readSegmentsFromDOM()

      // Text-resolved suggestions leave before any chip machinery runs: there
      // is no chip, so there is nothing for the chip-click editing path or the
      // onChipAdd callback below to be about.
      const asText = activeTrigger.config.insertAsText?.(suggestion)
      if (asText !== undefined) {
        const inserted = resolveText(segments, activeTrigger, asText)
        events.pushUndo(segments)
        onChange(inserted.segments)
        renderSegmentsToDOM(inserted.segments)
        const editor = editorRef.current
        if (editor) {
          setCursorAtOffset(editor, inserted.cursorOffset)
        }
        dismissTrigger()
        setTimeout(() => {
          editorRef.current?.focus()
        }, 0)
        return
      }

      const displayText = activeTrigger.config.onSelect?.(suggestion) ?? suggestion.label

      const chipData = {
        value: suggestion.value,
        displayText: displayText || suggestion.label,
        data: suggestion.data,
      }

      // Chip-click dropdown (`reopenOnChipClick`): the whole path lives in
      // use-chip-editing.ts; on true the chip was replaced in place (or the edit
      // was refused because the composer went disabled) and we only dismiss and
      // refocus here.
      if (chipEditing.trySelectEditingChip(segments, chipData, activeTrigger.config.char, events.pushUndo)) {
        dismissTrigger()
        setTimeout(() => {
          editorRef.current?.focus()
        }, 0)
        return
      }
      const result = resolveChip(segments, activeTrigger, chipData)

      onChange(result.segments)
      renderSegmentsToDOM(result.segments)

      onChipAdd?.({
        type: 'chip',
        trigger: activeTrigger.config.char,
        ...chipData,
      })

      const editor = editorRef.current
      if (editor) {
        setCursorAtOffset(editor, result.cursorOffset)
      }

      dismissTrigger()

      setTimeout(() => {
        editorRef.current?.focus()
      }, 0)
    },
    [activeTrigger, readSegmentsFromDOM, onChange, renderSegmentsToDOM, dismissTrigger, onChipAdd, events, chipEditing],
  )

  const selectSuggestion = selectSuggestionInternal

  // Handle key events — the numbered router and its chip-deletion helpers live in
  // use-prompt-area-keydown.ts.

  const handleKeyDown = usePromptAreaKeydown({
    editorRef,
    triggers,
    markdownEnabled,
    submitOnEnter,
    onSubmit,
    onEscape,
    onChange,
    onChipAdd,
    onChipDelete,
    readSegmentsFromDOM,
    renderSegmentsToDOM,
    runTriggerDetection,
    dismissTrigger,
    buildInsertChip,
    selectSuggestionInternal,
    activeTrigger,
    suggestions,
    suggestionsLoading,
    suggestionsError,
    selectedSuggestionIndex,
    setSelectedSuggestionIndex,
    pushUndo: events.pushUndo,
    handleKeyDownForUndoRedo: events.handleKeyDownForUndoRedo,
    lastRenderedValue,
    undoTimer,
    undoBaseState,
  })

  // Imperative handle (memoized to avoid identity changes)

  const handle: PromptAreaHandle = useMemo(
    () => ({
      focus: () => editorRef.current?.focus(),
      blur: () => editorRef.current?.blur(),
      insertChip: (chip) => {
        const segments = readSegmentsFromDOM()
        const newChip: ChipSegment = { type: 'chip', ...chip }
        const newSegments: Segment[] = [...segments, newChip, { type: 'text', text: ' ' }]
        onChange(newSegments)
        renderSegmentsToDOM(newSegments)
        onChipAdd?.(newChip)
      },
      getPlainText: () => segmentsToPlainText(readSegmentsFromDOM()),
      clear: () => {
        onChange([])
        const editor = editorRef.current
        if (editor) {
          while (editor.firstChild) {
            editor.removeChild(editor.firstChild)
          }
        }
        events.resetUndoHistory()
        if (undoTimer.current) {
          clearTimeout(undoTimer.current)
          undoTimer.current = null
        }
        undoBaseState.current = null
      },
      setText: (text) => {
        events.pushUndo(readSegmentsFromDOM())
        const segments = plainTextToSegments(text)
        onChange(segments)
        renderSegmentsToDOM(segments)
        const editor = editorRef.current
        if (editor) {
          setCursorAtOffset(editor, text.length)
        }
      },
      appendText: (text) => {
        const segments = readSegmentsFromDOM()
        events.pushUndo(segments)
        // Merge into the trailing text segment so the onChange value doesn't
        // carry two adjacent un-merged text segments.
        const last = segments[segments.length - 1]
        const next: Segment[] =
          last?.type === 'text'
            ? [...segments.slice(0, -1), { type: 'text', text: last.text + text }]
            : [...segments, { type: 'text', text }]
        onChange(next)
        renderSegmentsToDOM(next)
        const editor = editorRef.current
        if (editor) {
          setCursorAtOffset(editor, segmentsToPlainText(next).length)
        }
      },
      getCursorPosition: () => {
        const editor = editorRef.current
        return editor ? getCursorOffset(editor) : null
      },
      setCursorPosition: (offset) => {
        const editor = editorRef.current
        if (editor) {
          setCursorAtOffset(editor, offset)
        }
      },
      setCursorToEnd: () => {
        const editor = editorRef.current
        if (editor) {
          setCursorAtOffset(editor, segmentsToPlainText(readSegmentsFromDOM()).length)
        }
      },
      getSelection: () => {
        const editor = editorRef.current
        return editor ? getSelectionOffsets(editor) : null
      },
      setSelection: (start, end) => {
        const editor = editorRef.current
        if (editor) {
          setSelectionAtOffsets(editor, start, end)
        }
      },
    }),
    [readSegmentsFromDOM, onChange, renderSegmentsToDOM, onChipAdd, events],
  )

  // Compose event handlers

  const eventHandlers = useMemo(
    () => ({
      onPaste: events.handlePaste,
      onCopy: events.handleCopy,
      onCut: events.handleCut,
      onDrop: events.handleDrop,
      onDragOver: events.handleDragOver,
      onCompositionStart: events.handleCompositionStart,
      onCompositionEnd: events.handleCompositionEnd,
      onBlur: events.handleBlur,
    }),
    [
      events.handlePaste,
      events.handleCopy,
      events.handleCut,
      events.handleDrop,
      events.handleDragOver,
      events.handleCompositionStart,
      events.handleCompositionEnd,
      events.handleBlur,
    ],
  )

  return {
    editorRef,
    activeTrigger,
    suggestions,
    suggestionsLoading,
    suggestionsError,
    selectedSuggestionIndex,
    handleInput,
    handleKeyDown,
    handleClick: chipEditing.handleClick,
    handleMouseDown: chipEditing.handleMouseDown,
    selectSuggestion,
    dismissTrigger,
    handle,
    triggerRect,
    eventHandlers,
  }
}
