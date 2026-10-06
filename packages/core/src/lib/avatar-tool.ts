import { z } from 'zod'
import { defineToolFamily, globalSlot, lateBoundDirectory, type GatewayToolOutput } from './gateway-tools.ts'

export interface AvatarDirectory {
  // Rolls the calling agent a new avatar and answers a line for the model; throws when the session is not an agent.
  change(sessionId: string, seed?: string): Promise<string>
}

export const CHANGE_AVATAR_TOOL = 'change_avatar'
export const AVATAR_SEED_MAX = 64

const AVATAR_SLOT = globalSlot<AvatarDirectory>('workerdeck.avatar.directory')

const CHANGE_AVATAR_TOOL_SHAPES = {
  [CHANGE_AVATAR_TOOL]: {
    description:
      'Give yourself a new avatar: the picture the human sees beside your name in the session list. Each call rolls a ' +
      'new one; pass `seed` to get the same avatar for the same seed (any short word or phrase). You cannot see the ' +
      'result, so only change it when the human asks or you have a reason to.',
    shape: {
      seed: z.string().trim().min(1).max(AVATAR_SEED_MAX).optional().describe('Optional: the same seed always rolls the same avatar'),
    },
  },
} as const

const CHANGE_AVATAR_TOOLS = defineToolFamily<typeof CHANGE_AVATAR_TOOL_SHAPES, AvatarDirectory>(CHANGE_AVATAR_TOOL_SHAPES, {
  [CHANGE_AVATAR_TOOL]: async (directory, from, input) => ({ text: await directory.change(from, input.seed), isError: false }),
})

export const CHANGE_AVATAR_TOOL_SHAPE = CHANGE_AVATAR_TOOL_SHAPES[CHANGE_AVATAR_TOOL]

export function isChangeAvatarToolName(name: string): name is typeof CHANGE_AVATAR_TOOL {
  return CHANGE_AVATAR_TOOLS.is(name)
}

export function runChangeAvatarTool(directory: AvatarDirectory, from: string, args: unknown): Promise<GatewayToolOutput> {
  return CHANGE_AVATAR_TOOLS.run(directory, from, CHANGE_AVATAR_TOOL, args)
}

export function installAvatarDirectory(directory: AvatarDirectory | undefined): void {
  AVATAR_SLOT.install(directory)
}

export function avatarDirectoryHandle(own?: () => AvatarDirectory | undefined): AvatarDirectory {
  return lateBoundDirectory<AvatarDirectory>(['change'], AVATAR_SLOT, own, 'avatars are not available on this gateway')
}
