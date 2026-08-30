/**
 * Cursor/selection utilities for the PromptArea contentEditable.
 *
 * Invariants:
 * - All functions are synchronous. Never return a promise or cross a microtask
 *   boundary after a DOM mutation — that can cause the browser to fire
 *   `selectionchange` and reset the caret.
 * - Never cache a `Selection` or `Range` across calls. Ranges become detached
 *   after DOM mutations. Each function calls `window.getSelection()` or
 *   `getSelectionRange()` fresh.
 * - Chip nodes are treated atomically via `isChipElement` — we never descend
 *   into a contentEditable=false subtree when mapping offsets.
 */
import {
  chipNodeTextLength,
  getDirectChildContaining,
  getSelectionRange,
  indexOfChildNode,
  isBRElement,
  isChipElement,
  isHTMLElement,
} from './dom-helpers.ts'

export type SavedCursor = {
  nodeIndex: number
  offset: number
}

export function saveCursorPosition(editor: HTMLElement): SavedCursor | null {
  const range = getSelectionRange()
  if (!range) {
    return null
  }
  if (!editor.contains(range.startContainer)) {
    return null
  }

  const node = range.startContainer
  if (node === editor) {
    return { nodeIndex: range.startOffset, offset: 0 }
  }

  const directChild = getDirectChildContaining(editor, node)
  if (!directChild) {
    return null
  }

  const nodeIndex = indexOfChildNode(editor, directChild)
  return { nodeIndex, offset: range.startOffset }
}

export function restoreCursorPosition(editor: HTMLElement, saved: SavedCursor): void {
  const sel = window.getSelection()
  if (!sel) {
    return
  }

  const childNodes = editor.childNodes
  if (childNodes.length === 0) {
    return
  }

  const range = document.createRange()

  if (saved.nodeIndex >= childNodes.length) {
    const lastChild = childNodes[childNodes.length - 1]
    if (lastChild.nodeType === Node.TEXT_NODE) {
      range.setStart(lastChild, (lastChild.textContent ?? '').length)
    } else {
      range.setStartAfter(lastChild)
    }
  } else {
    const targetNode = childNodes[saved.nodeIndex]
    if (targetNode.nodeType === Node.TEXT_NODE) {
      const maxOffset = (targetNode.textContent ?? '').length
      range.setStart(targetNode, Math.min(saved.offset, maxOffset))
    } else {
      range.setStartAfter(targetNode)
    }
  }

  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

export function getCursorOffset(editor: HTMLElement): number | null {
  const range = getSelectionRange()
  if (!range) {
    return null
  }
  if (!editor.contains(range.startContainer)) {
    return null
  }

  const preRange = document.createRange()
  preRange.selectNodeContents(editor)
  preRange.setEnd(range.startContainer, range.startOffset)

  return getTextLengthInRange(preRange)
}

/**
 * Create a collapsed Range at the given plain-text offset inside the editor.
 * Returns null if the offset can't be mapped to a DOM position.
 */
export function createRangeAtOffset(editor: HTMLElement, targetOffset: number): Range | null {
  const pos = findDOMPosition(editor, targetOffset)
  if (!pos) {
    return null
  }

  const range = document.createRange()
  range.setStart(pos.node, pos.offset)
  range.collapse(true)
  return range
}

/**
 * Where the caret is on screen, in viewport coordinates.
 *
 * A collapsed range usually measures fine, but not when it sits *between* child
 * nodes of an element — which is exactly where a freshly inserted newline puts
 * it, because this editor's content is a flat run of text nodes and `<br>`s
 * directly under the editor element. There `getBoundingClientRect()` is all
 * zeros, and the obvious fallback (measure `startContainer`'s element) resolves
 * to the editor itself, whose rect is the viewport box — so it reports the
 * caret as trivially visible and scrolls nothing.
 *
 * So measure the neighbour instead: the child the caret sits before, or failing
 * that the one it sits after. Selecting a node gives a real rect even for a
 * `<br>`, which is what the line the caret just moved to consists of.
 */
function caretRect(range: Range): DOMRect | null {
  const direct = range.getBoundingClientRect()
  if (direct.height > 0) {
    return direct
  }

  const node = range.startContainer
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null
  }
  const children = (node as Element).childNodes
  const neighbours = [children[range.startOffset], children[range.startOffset - 1]]
  for (const neighbour of neighbours) {
    if (!neighbour) {
      continue
    }
    const probe = document.createRange()
    probe.selectNode(neighbour)
    const rect = probe.getBoundingClientRect()
    if (rect.height > 0) {
      return rect
    }
  }
  return null
}

/**
 * Keep the caret inside the editor's visible box after a *programmatic* move.
 *
 * The editor is its own scroll container once it hits `maxHeight`
 * (`prompt-area.tsx` sets `overflowY: auto` there). Typing scrolls the caret
 * into view for free, because that is the browser's own behaviour for a native
 * edit — but every path that calls `preventDefault()` and rebuilds the DOM
 * itself (Shift+Enter, list continuation, undo/redo, the bold/italic wrap,
 * paste) places the caret with a Range instead, and setting a selection does
 * not scroll anything. The symptom is a prompt that has grown past its cap and
 * stops following what you are writing: type and it scrolls, press Shift+Enter
 * and the new line appears below the fold.
 *
 * A no-op when the caret is already visible, so it is safe on every call — it
 * corrects an off-screen caret rather than scrolling to one.
 */
export function scrollCaretIntoView(editor: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    return
  }
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer)) {
    return
  }

  const rect = caretRect(range)
  if (!rect) {
    return
  }

  const box = editor.getBoundingClientRect()
  if (rect.bottom > box.bottom) {
    editor.scrollTop += rect.bottom - box.bottom
  } else if (rect.top < box.top) {
    editor.scrollTop -= box.top - rect.top
  }
}

export function setCursorAtOffset(editor: HTMLElement, targetOffset: number): void {
  const sel = window.getSelection()
  if (!sel) {
    return
  }

  const pos = findDOMPosition(editor, targetOffset)
  if (pos) {
    const range = document.createRange()
    range.setStart(pos.node, pos.offset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    scrollCaretIntoView(editor)
    return
  }

  // Fallback: place cursor at end
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  scrollCaretIntoView(editor)
}

export function getTextLengthInRange(range: Range): number {
  const fragment = range.cloneContents()
  let length = 0

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      length += (node.textContent ?? '').length
    } else if (isChipElement(node)) {
      length += chipNodeTextLength(node)
    } else if (isHTMLElement(node) && node.tagName === 'BR') {
      if (node.dataset.sentinel) {
        return
      } // skip sentinel <br>
      length += 1
    } else if (isHTMLElement(node)) {
      node.childNodes.forEach(walk)
    }
  }

  fragment.childNodes.forEach(walk)
  return length
}

/**
 * Returns the start and end plain-text offsets of the current selection.
 * Returns null if there's no selection or it's outside the editor.
 */
export function getSelectionOffsets(editor: HTMLElement): { start: number; end: number } | null {
  const range = getSelectionRange()
  if (!range) {
    return null
  }
  if (!editor.contains(range.startContainer)) {
    return null
  }

  const startRange = document.createRange()
  startRange.selectNodeContents(editor)
  startRange.setEnd(range.startContainer, range.startOffset)
  const start = getTextLengthInRange(startRange)

  if (range.collapsed) {
    return { start, end: start }
  }

  const endRange = document.createRange()
  endRange.selectNodeContents(editor)
  endRange.setEnd(range.endContainer, range.endOffset)
  const end = getTextLengthInRange(endRange)

  return { start, end }
}

/**
 * Sets a (potentially non-collapsed) selection at the given plain-text offsets.
 * Used to restore selection after markdown wrap/unwrap operations.
 */
export function setSelectionAtOffsets(editor: HTMLElement, startOffset: number, endOffset: number): void {
  const sel = window.getSelection()
  if (!sel) {
    return
  }

  if (startOffset === endOffset) {
    setCursorAtOffset(editor, startOffset)
    return
  }

  const startPos = findDOMPosition(editor, startOffset)
  const endPos = findDOMPosition(editor, endOffset)
  if (!startPos || !endPos) {
    return
  }

  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * Maps a plain-text offset to a DOM node + offset pair.
 * Recurses into decoration elements (markdown spans, URL anchors).
 */
export function findDOMPosition(container: HTMLElement, targetOffset: number): { node: Node; offset: number } | null {
  let remaining = targetOffset

  for (let i = 0; i < container.childNodes.length; i++) {
    const child = container.childNodes[i]

    if (child.nodeType === Node.TEXT_NODE) {
      const len = (child.textContent ?? '').length
      if (remaining <= len) {
        return { node: child, offset: remaining }
      }
      remaining -= len
    } else if (isChipElement(child)) {
      const chipLen = chipNodeTextLength(child)
      if (remaining <= chipLen) {
        return { node: container, offset: i + 1 }
      }
      remaining -= chipLen
    } else if (isBRElement(child)) {
      if (child.dataset.sentinel) {
        continue
      } // skip sentinel <br>
      if (remaining <= 1) {
        return { node: container, offset: i + 1 }
      }
      remaining -= 1
    } else if (isHTMLElement(child)) {
      // Decoration element (markdown span, URL anchor) — recurse
      const textLen = (child.textContent ?? '').length
      if (remaining <= textLen) {
        const result = findDOMPosition(child, remaining)
        if (result) {
          return result
        }
      }
      remaining -= textLen
    }
  }

  // Fallback: end of container
  return { node: container, offset: container.childNodes.length }
}
