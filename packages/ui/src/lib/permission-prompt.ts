import type { PermissionRequest } from '@workerdeck/protocol'
import { planFromRequest } from './plan-request.ts'
import { shellRequestPayload, shellRequestTitle, type ShellRequestPayload } from './shell-request.ts'

export type PermissionChoiceKey = 'allow' | 'deny' | 'stop'

export type PermissionChoice = {
  key: PermissionChoiceKey
  button: string
  option: string
  danger?: boolean
}

export type PermissionPromptModel = {
  plan?: string
  shell?: ShellRequestPayload
  heading: string
  question: string
  description?: string
  decisionReason?: string
  choices: [PermissionChoice, PermissionChoice, PermissionChoice]
  denyPlaceholder: string
}

type PermissionRequestLike = Pick<PermissionRequest, 'toolName' | 'input' | 'title' | 'displayName' | 'description' | 'decisionReason'>

export function permissionPromptModel(request: PermissionRequestLike): PermissionPromptModel {
  const plan = planFromRequest(request)
  const shell = plan ? undefined : shellRequestPayload(request)
  const context = { description: request.description, decisionReason: request.decisionReason }
  if (plan) {
    return {
      plan,
      heading: 'Plan ready for review',
      question: 'Ready to implement this plan?',
      ...context,
      choices: [
        { key: 'allow', button: 'Approve plan', option: 'Approve plan' },
        { key: 'deny', button: 'Keep planning', option: 'Keep planning - tell it what to change' },
        { key: 'stop', button: 'Stop the turn', option: 'No, and stop the turn', danger: true },
      ],
      denyPlaceholder: 'What should change? (optional) - the agent keeps planning and reads this',
    }
  }
  return {
    shell,
    heading: shell ? shellRequestTitle(shell) : (request.title ?? request.displayName ?? 'Permission needed'),
    question: shell ? 'Do you want to let it?' : 'Do you want to proceed?',
    ...context,
    choices: [
      { key: 'allow', button: 'Allow', option: 'Yes' },
      { key: 'deny', button: 'Deny', option: 'No, and tell the agent what to do differently' },
      { key: 'stop', button: 'Deny & stop', option: 'No, and stop the turn', danger: true },
    ],
    denyPlaceholder: 'Reason (optional) - the agent reads this and can try something else',
  }
}
