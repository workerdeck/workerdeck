'use client'

import { useCallback } from 'react'
import type { Segment, TriggerConfig, ActiveTrigger, TriggerSuggestion, ChipSegment } from './types.ts'
import {
  isValidTriggerPosition,
  segmentsToPlainText,
  resolveChip,
  removeChipAtIndex,
  revertChipAtIndex,
  replaceTextRange,
  toggleMarkdownWrap,
} from './prompt-area-engine.ts'
import {
  getListContext,
  insertListContinuation,
  indentListItem,
  outdentListItem,
  removeListPrefix,
  renumberOrderedListSegments,
  remapOffset,
} from './prompt-area-list-ops.ts'
import {
  isChipElement,
  getChipAutoResolved,
  getDirectChildContaining,
  indexOfChildNode,
  domChildIndexToSegmentIndex,
  getSelectionRange,
} from './dom-helpers.ts'
import { getCursorOffset, setCursorAtOffset, getSelectionOffsets, setSelectionAtOffsets } from './cursor-helpers.ts'

type UsePromptAreaKeydownOptions = {
  editorRef: React.RefObject<HTMLDivElement | null>
  triggers: TriggerConfig[]
  markdownEnabled: boolean
  submitOnEnter: boolean
  onSubmit?: (segments: Segment[]) => void
  onEscape?: () => void
  onChange: (segments: Segment[]) => void
  onChipAdd?: (chip: ChipSegment) => void
  onChipDelete?: (chip: ChipSegment) => void
  readSegmentsFromDOM: () => Segment[]
  renderSegmentsToDOM: (segments: Segment[]) => void
  runTriggerDetection: () => void
  dismissTrigger: () => void
  buildInsertChip: (segments: Segment[], trigger: ActiveTrigger) => (chip: Omit<ChipSegment, 'type'>) => void
  selectSuggestionInternal: (suggestion: TriggerSuggestion) => void
  activeTrigger: ActiveTrigger | null
  suggestions: TriggerSuggestion[]
  suggestionsLoading: boolean
  suggestionsError: string | null
  selectedSuggestionIndex: number
  setSelectedSuggestionIndex: React.Dispatch<React.SetStateAction<number>>
  pushUndo: (segments: Segment[]) => void
  handleKeyDownForUndoRedo: (e: React.KeyboardEvent<HTMLDivElement>) => boolean
  lastRenderedValue: React.RefObject<Segment[]>
  undoTimer: React.RefObject<ReturnType<typeof setTimeout> | null>
  undoBaseState: React.RefObject<Segment[] | null>
}

// The numbered keydown router (branches 1 through 6) and the chip-deletion helpers only it
// calls, moved whole from use-prompt-area.ts. The numbering is load-bearing documentation:
// branch order IS the precedence order.
export function usePromptAreaKeydown({
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
  pushUndo,
  handleKeyDownForUndoRedo,
  lastRenderedValue,
  undoTimer,
  undoBaseState,
}: UsePromptAreaKeydownOptions): (e: React.KeyboardEvent<HTMLDivElement>) => void {
  // Remove a chip node from DOM and sync model

  const removeChipNodeFromDOM = useCallback(
    (editor: HTMLElement, chipNode: HTMLElement): boolean => {
      const segments = readSegmentsFromDOM()
      const chipIdx = indexOfChildNode(editor, chipNode)
      if (chipIdx === -1) {
        return false
      }

      const segIdx = domChildIndexToSegmentIndex(editor, chipIdx)
      const deletedChip = segments[segIdx]
      const newSegments = removeChipAtIndex(segments, segIdx)
      onChange(newSegments)
      renderSegmentsToDOM(newSegments)

      if (deletedChip?.type === 'chip') {
        onChipDelete?.(deletedChip)
      }

      return true
    },
    [readSegmentsFromDOM, onChange, renderSegmentsToDOM, onChipDelete],
  )

  // Revert an auto-resolved chip back to plain text

  const revertChipNodeToText = useCallback(
    (editor: HTMLElement, chipNode: HTMLElement): boolean => {
      const segments = readSegmentsFromDOM()
      const chipIdx = indexOfChildNode(editor, chipNode)
      if (chipIdx === -1) {
        return false
      }

      const segIdx = domChildIndexToSegmentIndex(editor, chipIdx)
      const revertedChip = segments[segIdx]
      const result = revertChipAtIndex(segments, segIdx)
      if (!result) {
        return false
      }

      let targetOffset = 0
      for (let i = 0; i < segIdx; i++) {
        const s = segments[i]
        if (s.type === 'text') {
          targetOffset += s.text.length
        } else {
          targetOffset += s.trigger.length + s.displayText.length
        }
      }
      targetOffset += result.revertedText.length

      onChange(result.segments)
      renderSegmentsToDOM(result.segments)
      setCursorAtOffset(editor, targetOffset)

      if (revertedChip?.type === 'chip') {
        onChipDelete?.(revertedChip)
      }

      return true
    },
    [readSegmentsFromDOM, onChange, renderSegmentsToDOM, onChipDelete],
  )

  // Chip backspace (delete chip behind cursor as whole unit)

  const handleChipBackspace = useCallback((): boolean => {
    const editor = editorRef.current
    if (!editor) {
      return false
    }

    const range = getSelectionRange()
    if (!range || !range.collapsed) {
      return false
    }

    const node = range.startContainer
    const offset = range.startOffset

    // Case 1: cursor is at the editor level (between child nodes)
    if (node === editor && offset > 0) {
      const prevChild = editor.childNodes[offset - 1]
      if (prevChild && isChipElement(prevChild)) {
        if (getChipAutoResolved(prevChild)) {
          return revertChipNodeToText(editor, prevChild)
        }
        return removeChipNodeFromDOM(editor, prevChild)
      }
    }

    // Case 2: cursor is at start of a text node, check previous sibling
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
      const directChild = getDirectChildContaining(editor, node)
      if (!directChild) {
        return false
      }

      let prevSibling = directChild.previousSibling
      while (prevSibling && prevSibling.nodeType === Node.TEXT_NODE && prevSibling.textContent === '') {
        prevSibling = prevSibling.previousSibling
      }
      if (prevSibling && isChipElement(prevSibling)) {
        if (getChipAutoResolved(prevSibling)) {
          return revertChipNodeToText(editor, prevSibling)
        }
        return removeChipNodeFromDOM(editor, prevSibling)
      }
    }

    return false
  }, [removeChipNodeFromDOM, revertChipNodeToText])

  // Chip forward delete (delete chip in front of cursor)

  const handleChipForwardDelete = useCallback((): boolean => {
    const editor = editorRef.current
    if (!editor) {
      return false
    }

    const range = getSelectionRange()
    if (!range || !range.collapsed) {
      return false
    }

    const node = range.startContainer
    const offset = range.startOffset

    // Case 1: cursor at the editor level
    if (node === editor && offset < editor.childNodes.length) {
      const nextChild = editor.childNodes[offset]
      if (nextChild && isChipElement(nextChild)) {
        return removeChipNodeFromDOM(editor, nextChild)
      }
    }

    // Case 2: cursor at end of a text node, check next sibling
    if (node.nodeType === Node.TEXT_NODE && offset === (node.textContent ?? '').length) {
      const directChild = getDirectChildContaining(editor, node)
      if (!directChild) {
        return false
      }

      let nextSibling = directChild.nextSibling
      while (nextSibling && nextSibling.nodeType === Node.TEXT_NODE && nextSibling.textContent === '') {
        nextSibling = nextSibling.nextSibling
      }
      if (nextSibling && isChipElement(nextSibling)) {
        return removeChipNodeFromDOM(editor, nextSibling)
      }
    }

    return false
  }, [removeChipNodeFromDOM])

  // Auto-resolve active trigger on space

  const autoResolveActiveTrigger = useCallback(
    (trigger: ActiveTrigger) => {
      const segments = readSegmentsFromDOM()
      const query = trigger.query

      const syntheticSuggestion: TriggerSuggestion = {
        value: query,
        label: query,
      }

      const displayText = trigger.config.onSelect?.(syntheticSuggestion) ?? query

      const chipData = {
        value: query,
        displayText: displayText || query,
        autoResolved: true,
      }
      const result = resolveChip(segments, trigger, chipData)

      onChange(result.segments)
      renderSegmentsToDOM(result.segments)

      onChipAdd?.({
        type: 'chip',
        trigger: trigger.config.char,
        ...chipData,
      })

      const editor = editorRef.current
      if (editor) {
        setCursorAtOffset(editor, result.cursorOffset)
      }

      dismissTrigger()
    },
    [readSegmentsFromDOM, onChange, renderSegmentsToDOM, dismissTrigger, onChipAdd],
  )

  // Handle key events

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const applyEditResult = (editor: HTMLDivElement, result: { segments: Segment[]; cursorOffset: number }) => {
        // Ordered-list numbers are a projection of position: rebuild them on
        // every structural edit and remap the caret across any digit-run width
        // changes. No-op (same reference) when there are no ordered lists.
        let { segments, cursorOffset } = result
        if (markdownEnabled) {
          const renumbered = renumberOrderedListSegments(segments)
          segments = renumbered.segments
          cursorOffset = remapOffset(cursorOffset, renumbered.edits)
        }
        lastRenderedValue.current = segments
        onChange(segments)
        renderSegmentsToDOM(segments)
        setCursorAtOffset(editor, cursorOffset)
      }

      const tryListContinuation = (editor: HTMLDivElement): boolean => {
        if (!markdownEnabled) {
          return false
        }
        const segments = readSegmentsFromDOM()
        const cursorPos = getCursorOffset(editor)
        if (cursorPos === null) {
          return false
        }
        const plainText = segmentsToPlainText(segments)
        if (!getListContext(plainText, cursorPos)) {
          return false
        }
        const result = insertListContinuation(segments, cursorPos)
        if (result) {
          applyEditResult(editor, result)
        }
        return true
      }

      // 1. Flush pending undo debounce so Cmd+Z has the latest checkpoint
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && undoBaseState.current) {
        if (undoTimer.current) {
          clearTimeout(undoTimer.current)
          undoTimer.current = null
        }
        pushUndo(undoBaseState.current)
        undoBaseState.current = null
      }

      // 1a. Undo/redo intercept
      if (handleKeyDownForUndoRedo(e)) {
        return
      }

      // 1.5 Markdown formatting shortcuts (Cmd+B bold, Cmd+I italic)
      if (markdownEnabled && (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
        e.preventDefault()
        const editor = editorRef.current
        if (!editor) {
          return
        }

        const offsets = getSelectionOffsets(editor)
        if (!offsets || offsets.start === offsets.end) {
          return
        }

        const marker = e.key === 'b' ? '**' : '*'
        const currentSegments = readSegmentsFromDOM()
        pushUndo(currentSegments)

        const result = toggleMarkdownWrap(currentSegments, offsets.start, offsets.end, marker)
        if (!result) {
          return
        }

        lastRenderedValue.current = result.segments
        onChange(result.segments)
        renderSegmentsToDOM(result.segments)
        setSelectionAtOffsets(editor, result.selectionStart, result.selectionEnd)
        return
      }

      // 1.75 Launch triggers: a trigger with mode 'launch' fires onActivate on
      // keydown and suppresses the char so it never enters the editor — for
      // opening an external surface (dialog, palette). The DOM read is gated on
      // the typed key actually matching a launch char, so it stays off the hot
      // path. insertChip still inserts a chip at the cursor if the consumer
      // wants one after the external selection.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing && e.key.length === 1) {
        const launcher = triggers.find((t) => t.mode === 'launch' && t.char === e.key)
        const editor = editorRef.current
        if (launcher?.onActivate && editor) {
          const cursorPos = getCursorOffset(editor)
          if (cursorPos !== null) {
            const segments = readSegmentsFromDOM()
            const plainText = segmentsToPlainText(segments)
            if (isValidTriggerPosition(plainText, cursorPos, launcher.position)) {
              e.preventDefault()
              launcher.onActivate({
                text: plainText,
                cursorPosition: cursorPos,
                insertChip: buildInsertChip(replaceTextRange(segments, cursorPos, cursorPos, launcher.char), {
                  config: launcher,
                  startOffset: cursorPos,
                  query: '',
                }),
              })
              return
            }
          }
        }
      }

      // 2. Trigger dropdown navigation. Gated on the dropdown actually being
      // ON SCREEN, which matches TriggerPopover's own render condition
      // (non-empty suggestions, OR loading/error/emptyMessage) rather than
      // just `suggestions.length > 0` — otherwise a popover left open in a
      // loading/empty state (e.g. right after a chip-click reopen, before its
      // empty-query search resolves) lets Enter fall through to onSubmit and
      // Escape fall through to onEscape while still visibly on screen.
      const dropdownVisible =
        activeTrigger &&
        activeTrigger.config.mode === 'dropdown' &&
        (suggestions.length > 0 || suggestionsLoading || suggestionsError !== null || !!activeTrigger.config.emptyMessage)
      if (dropdownVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (suggestions.length > 0) {
            setSelectedSuggestionIndex((prev) => Math.min(prev + 1, suggestions.length - 1))
          }
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (suggestions.length > 0) {
            setSelectedSuggestionIndex((prev) => Math.max(prev - 1, 0))
          }
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selected = suggestions[selectedSuggestionIndex]
          if (selected) {
            selectSuggestionInternal(selected)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissTrigger()
          return
        }
      }

      // 2.5. Auto-resolve on Space when trigger has resolveOnSpace
      if (e.key === ' ' && activeTrigger && activeTrigger.config.resolveOnSpace) {
        const query = activeTrigger.query.trim()
        if (query.length > 0) {
          e.preventDefault()
          autoResolveActiveTrigger(activeTrigger)
          return
        }
      }

      // 2.6. Tab/Shift+Tab for list indentation (only when trigger dropdown is NOT open)
      if (markdownEnabled && e.key === 'Tab' && !activeTrigger) {
        const editor = editorRef.current
        if (editor) {
          const segments = readSegmentsFromDOM()
          const plainText = segmentsToPlainText(segments)
          const cursorPos = getCursorOffset(editor)
          if (cursorPos !== null) {
            const ctx = getListContext(plainText, cursorPos)
            if (ctx) {
              e.preventDefault()
              const result = e.shiftKey ? outdentListItem(segments, cursorPos) : indentListItem(segments, cursorPos)
              if (result) {
                applyEditResult(editor, result)
              }
              return
            }
          }
        }
      }

      // Insert a newline at the model level (avoids the browser's broken
      // contentEditable behaviour near <a> elements).
      const insertPlainNewline = (editor: HTMLDivElement): void => {
        const offsets = getSelectionOffsets(editor)
        if (!offsets) {
          return
        }
        const currentSegments = readSegmentsFromDOM()
        pushUndo(currentSegments)
        const newSegments = replaceTextRange(currentSegments, offsets.start, offsets.end, '\n')
        applyEditResult(editor, { segments: newSegments, cursorOffset: offsets.start + 1 })
      }

      // 2.8 Shift+Enter always inserts a newline (after a list-continuation check).
      if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const editor = editorRef.current
        if (editor && !tryListContinuation(editor)) {
          insertPlainNewline(editor)
        }
        return
      }

      // 3. Enter without Shift (skipping IME): under `submitOnEnter` it submits
      // *unconditionally* — the send key must not turn into "another bullet" because
      // of what the line above starts with; list continuation lives on Shift+Enter
      // (branch 2.8). Without `submitOnEnter`, Enter is the newline key and continues.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (submitOnEnter) {
          onSubmit?.(readSegmentsFromDOM())
          return
        }
        const editor = editorRef.current
        if (editor && !tryListContinuation(editor)) {
          insertPlainNewline(editor)
        }
        return
      }

      // 4. Escape
      if (e.key === 'Escape' && onEscape) {
        onEscape()
        return
      }

      // 4.5 Non-collapsed selection delete (Backspace/Delete across <a> boundaries)
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.nativeEvent.isComposing) {
        const editor = editorRef.current
        if (editor) {
          const offsets = getSelectionOffsets(editor)
          if (offsets && offsets.start !== offsets.end) {
            e.preventDefault()
            const currentSegments = readSegmentsFromDOM()
            pushUndo(currentSegments)
            const newSegments = replaceTextRange(currentSegments, offsets.start, offsets.end, '')
            applyEditResult(editor, { segments: newSegments, cursorOffset: offsets.start })
            runTriggerDetection()
            return
          }
        }
      }

      // 5. Backspace: check list prefix removal, then chip deletion
      if (e.key === 'Backspace') {
        const editor = editorRef.current
        if (editor) {
          const segments = readSegmentsFromDOM()
          const cursorPos = getCursorOffset(editor)
          if (markdownEnabled && cursorPos !== null) {
            const result = removeListPrefix(segments, cursorPos)
            if (result) {
              e.preventDefault()
              applyEditResult(editor, result)
              runTriggerDetection()
              return
            }
          }
        }
        if (handleChipBackspace()) {
          e.preventDefault()
          runTriggerDetection()
          return
        }
      }

      // 6. Delete (forward): delete chip as whole unit
      if (e.key === 'Delete' && handleChipForwardDelete()) {
        e.preventDefault()
        runTriggerDetection()
        return
      }
    },
    [
      activeTrigger,
      suggestions,
      suggestionsLoading,
      suggestionsError,
      selectedSuggestionIndex,
      onSubmit,
      submitOnEnter,
      onEscape,
      readSegmentsFromDOM,
      onChange,
      renderSegmentsToDOM,
      markdownEnabled,
      dismissTrigger,
      handleChipBackspace,
      handleChipForwardDelete,
      autoResolveActiveTrigger,
      runTriggerDetection,
      selectSuggestionInternal,
      pushUndo,
      handleKeyDownForUndoRedo,
      triggers,
      buildInsertChip,
    ],
  )

  return handleKeyDown
}
