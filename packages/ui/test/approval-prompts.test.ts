import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { PermissionPrompt } from '../src/components/agent/PermissionPrompt.tsx'
import { ShellProposalPrompt } from '../src/components/agent/ShellProposalPrompt.tsx'
import { TerminalPermissionPrompt } from '../src/components/terminal/PermissionPrompt.tsx'
import { TerminalShellProposalPrompt } from '../src/components/terminal/ShellProposalPrompt.tsx'
import type { ApprovalPromptProps } from '../src/components/agent/SessionPanel.tsx'

// The registry's whole fallback story is that a host registered for a tool can mount the
// built-in card for an input it does not want to draw. That only holds while both prompts
// stay assignable to the slot, and a stray required prop on either would break it silently.
describe('approvalPrompts', () => {
  it('accepts the built-in prompts as drop-in fallbacks, in both themes', () => {
    const cards: ComponentType<ApprovalPromptProps> = PermissionPrompt
    const terminal: ComponentType<ApprovalPromptProps> = TerminalPermissionPrompt
    expect([cards, terminal].every((prompt) => typeof prompt === 'function')).toBe(true)
  })

  it('accepts the proposal cards in the same slot, so a host can fall back to them for shell_propose', () => {
    const cards: ComponentType<ApprovalPromptProps> = ShellProposalPrompt
    const terminal: ComponentType<ApprovalPromptProps> = TerminalShellProposalPrompt
    expect([cards, terminal].every((prompt) => typeof prompt === 'function')).toBe(true)
  })
})
