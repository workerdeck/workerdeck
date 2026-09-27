import type { PermissionRequest, UserQuestion } from '@workerdeck/protocol'
import type { ApprovalResolution } from '../../lib/runner-core.ts'
import type { PermissionDecision } from '../../runner-interface.ts'
import type {
  AppServerCommandApprovalParams,
  AppServerDynamicToolCallParams,
  AppServerElicitationParams,
  AppServerFileChangeApprovalParams,
  AppServerPermissionsApprovalParams,
  AppServerUserInputParams,
  AppServerUserInputQuestion,
} from './types.ts'

type ApprovalSurface = Pick<PermissionRequest, 'toolName' | 'input' | 'title' | 'displayName' | 'description' | 'decisionReason'>

export type ApprovalChannel = {
  describe(params: unknown): ApprovalSurface
  itemId(params: unknown): string | undefined
  allow(
    params: unknown,
    updatedInput: Record<string, unknown> | undefined,
    offered: Set<string> | undefined,
  ): { response: unknown; decision?: string } | undefined
  deny(params: unknown, interrupt: boolean, offered: Set<string> | undefined, message?: string): { response: unknown; decision?: string }
}

export type ShellWriteVerdict = { allowed: true; updatedInput?: Record<string, unknown> } | { allowed: false; message?: string }

type ApprovalAnswer = { sent: { response: unknown; decision?: string }; resolution: ApprovalResolution }

// The gateway's own gate on the agent's shell write tools: codex answers `item/tool/call` with no reviewer of its
// own, so the card is raised here before the call runs. The verdict is what the awaiting caller reads; `decision`
// is left unset on a deny so an interrupting deny also interrupts the turn, which a tool error alone would not.
export const SHELL_WRITE_CHANNEL: ApprovalChannel = {
  describe: (raw) => {
    const call = raw as AppServerDynamicToolCallParams
    const input = typeof call.arguments === 'object' && call.arguments !== null ? (call.arguments as Record<string, unknown>) : {}
    return { toolName: call.tool, input, title: `Agent wants to run ${call.tool}`, displayName: call.tool }
  },
  itemId: (raw) => (raw as AppServerDynamicToolCallParams).callId,
  allow: (_raw, updatedInput) => ({ response: { allowed: true, updatedInput } satisfies ShellWriteVerdict }),
  deny: (_raw, _interrupt, _offered, message) => ({ response: { allowed: false, message } satisfies ShellWriteVerdict }),
}

export const APPROVAL_CHANNELS: Record<string, ApprovalChannel> = {
  'item/commandExecution/requestApproval': decisionChannel(
    (raw) => {
      const params = raw as AppServerCommandApprovalParams
      const command = params.command ?? undefined
      return {
        toolName: 'CodexCommand',
        input: {
          ...(command !== undefined ? { command } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? (command ? `Codex wants to run: ${command}` : 'Codex wants to run a command'),
        displayName: 'Run command',
        description: params.reason && command ? command : (params.cwd ?? undefined),
        decisionReason: params.reason ?? undefined,
      }
    },
    (raw) => (raw as AppServerCommandApprovalParams).itemId,
  ),
  'item/fileChange/requestApproval': decisionChannel(
    (raw) => {
      const params = raw as AppServerFileChangeApprovalParams
      return {
        toolName: 'CodexFileChange',
        input: {
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? 'Codex wants to apply file changes',
        displayName: 'Apply file changes',
        description: params.grantRoot ? `write access under ${params.grantRoot}` : undefined,
        decisionReason: params.reason ?? undefined,
      }
    },
    (raw) => (raw as AppServerFileChangeApprovalParams).itemId,
  ),
  'item/permissions/requestApproval': {
    describe: (raw) => {
      const params = raw as AppServerPermissionsApprovalParams
      return {
        toolName: 'CodexPermissions',
        input: {
          ...(params.permissions ? { permissions: params.permissions } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
        title: params.reason ?? 'Codex requests additional permissions',
        displayName: 'Grant permissions',
        description: undefined,
        decisionReason: params.reason ?? undefined,
      }
    },
    itemId: (raw) => (raw as AppServerPermissionsApprovalParams).itemId,
    allow: (raw, updatedInput) => ({
      response: {
        permissions:
          (updatedInput?.permissions as Record<string, unknown> | undefined) ??
          (raw as AppServerPermissionsApprovalParams).permissions ??
          {},
      },
    }),
    deny: () => ({ response: { permissions: {} } }),
  },
  'item/tool/requestUserInput': {
    describe: (raw) => ({
      toolName: 'AskUserQuestion',
      input: {
        questions: userQuestionsFromCodex((raw as AppServerUserInputParams).questions ?? []),
      },
      title: 'Codex asks a question',
      displayName: 'Answer questions',
      description: undefined,
      decisionReason: undefined,
    }),
    itemId: (raw) => (raw as AppServerUserInputParams).itemId,
    allow: (raw, updatedInput) => ({
      response: {
        answers: codexAnswers(
          (raw as AppServerUserInputParams).questions ?? [],
          updatedInput?.answers as Record<string, unknown> | undefined,
        ),
      },
    }),
    deny: () => ({ response: { answers: {} } }),
  },
  'mcpServer/elicitation/request': {
    describe: (raw) => {
      const params = raw as AppServerElicitationParams
      return {
        toolName: 'CodexMcpElicitation',
        input: {
          ...(params.serverName ? { serverName: params.serverName } : {}),
          ...(params.message ? { message: params.message } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
          ...(params.requestedSchema !== undefined ? { requestedSchema: params.requestedSchema } : {}),
          ...(params.url ? { url: params.url } : {}),
        },
        title: params.serverName ? `MCP server '${params.serverName}' requests input` : 'An MCP server requests input',
        displayName: 'MCP elicitation',
        description: params.message ?? undefined,
        decisionReason: undefined,
      }
    },
    itemId: () => undefined,
    allow: (_raw, updatedInput) => ({
      response: {
        action: 'accept',
        ...(updatedInput !== undefined ? { content: updatedInput } : {}),
      },
    }),
    deny: (_raw, interrupt) => ({ response: { action: interrupt ? 'cancel' : 'decline' } }),
  },
}

function decisionChannel(describe: (params: unknown) => ApprovalSurface, itemId: (params: unknown) => string | undefined): ApprovalChannel {
  return {
    describe,
    itemId,
    allow: (_params, _updatedInput, offered) => {
      const decision = pickDecision('allow', false, offered)
      return decision ? { response: { decision }, decision } : undefined
    },
    deny: (_params, interrupt, offered) => {
      const decision = pickDecision('deny', interrupt, offered)!
      return { response: { decision }, decision }
    },
  }
}

export function offeredDecisions(params: unknown): Set<string> | undefined {
  const raw = (params as { availableDecisions?: unknown })?.availableDecisions
  if (!Array.isArray(raw)) {
    return undefined
  }
  const names = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string') {
      names.add(entry)
    } else if (entry && typeof entry === 'object') {
      for (const key of Object.keys(entry)) {
        names.add(key)
      }
    }
  }
  return names.size > 0 ? names : undefined
}

function pickDecision(behavior: 'allow' | 'deny', interrupt: boolean, offered: Set<string> | undefined): string | undefined {
  const has = (name: string) => !offered || offered.has(name)
  if (behavior === 'allow') {
    return has('accept') ? 'accept' : undefined
  }
  if (interrupt && has('cancel')) {
    return 'cancel'
  }
  return 'decline'
}

function userQuestionsFromCodex(questions: readonly AppServerUserInputQuestion[]): UserQuestion[] {
  return questions.map((question) => ({
    question: question.question,
    header: question.header ?? '',
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
  }))
}

function codexAnswers(
  questions: readonly AppServerUserInputQuestion[],
  answers: Record<string, unknown> | undefined,
): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {}
  for (const question of questions) {
    const value = answers?.[question.question] ?? answers?.[question.id]
    if (typeof value === 'string' && value.length > 0) {
      out[question.id] = { answers: [value] }
    }
  }
  return out
}

export function answerApproval(
  channel: ApprovalChannel,
  params: unknown,
  offered: Set<string> | undefined,
  decision: PermissionDecision,
  resolvedBy: ApprovalResolution['resolvedBy'],
): ApprovalAnswer {
  if (decision.behavior === 'allow') {
    const allowed = channel.allow(params, decision.updatedInput, offered)
    if (allowed) {
      return { sent: allowed, resolution: { behavior: 'allow', resolvedBy, message: undefined } }
    }
    return {
      sent: channel.deny(params, false, offered),
      resolution: {
        behavior: 'deny',
        resolvedBy: 'policy',
        message: 'codex offered no plain accept for this request (only broader session/policy grants), denied instead',
      },
    }
  }
  const message = decision.message ?? 'Denied'
  return {
    sent: channel.deny(params, decision.interrupt === true, offered, message),
    resolution: { behavior: 'deny', resolvedBy, message },
  }
}

export function recommendedAnswers(params: unknown): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of (params as AppServerUserInputParams).questions ?? []) {
    const first = question.options?.[0]?.label
    if (first) {
      answers[question.id] = { answers: [first] }
    }
  }
  return answers
}
