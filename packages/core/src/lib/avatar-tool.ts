import { FACE_KINDS, FACE_SWATCHES, FACE_TONES, type AgentFacePatch } from '@workerdeck/protocol'
import { z } from 'zod'
import { defineToolFamily, globalSlot, lateBoundDirectory, type GatewayToolOutput } from './gateway-tools.ts'

export interface AvatarDirectory {
  // Rolls the calling agent a new face (or merges `parts` over its current one) and answers a line for the model; throws
  // when the session is not an agent.
  change(sessionId: string, request: { seed?: string; parts?: AgentFacePatch }): Promise<string>
}

export const CHANGE_AVATAR_TOOL = 'change_avatar'
export const AVATAR_SEED_MAX = 64

const AVATAR_SLOT = globalSlot<AvatarDirectory>('workerdeck.avatar.directory')

const COLOR = z
  .string()
  .regex(/^[a-z]+(\/[a-z]+)?$/)
  .optional()
  .describe(`A swatch (${FACE_SWATCHES.join(', ')}, or project for the project's colour), optionally /tone (${FACE_TONES.join(', ')})`)

const part = <K extends readonly [string, ...string[]]>(kinds: K) =>
  z.object({ kind: z.enum(kinds).optional(), color: COLOR }).optional()

const CHANGE_AVATAR_TOOL_SHAPES = {
  [CHANGE_AVATAR_TOOL]: {
    description:
      'Change your avatar: the small robot the human sees beside your name in the session list. With no arguments it ' +
      'rolls a new robot; `seed` rolls the same robot for the same seed. Or name the parts you want and keep the rest: ' +
      'a head (`tile`: shape and colour), an `antenna`, a `visor`, `eyes` and a `mouth`, each a kind and a colour, on a ' +
      '`backdrop`. The head and backdrop default to your project colour. You cannot see the result, so only change it ' +
      'when the human asks or you have a reason to.',
    shape: {
      seed: z.string().trim().min(1).max(AVATAR_SEED_MAX).optional().describe('Optional: the same seed always rolls the same robot'),
      backdrop: z.object({ color: COLOR }).optional(),
      tile: z.object({ shape: z.enum(FACE_KINDS.tile).optional(), color: COLOR }).optional(),
      antenna: part(FACE_KINDS.antenna),
      visor: part(FACE_KINDS.visor),
      eyes: part(FACE_KINDS.eyes),
      mouth: part(FACE_KINDS.mouth),
    },
  },
} as const

const CHANGE_AVATAR_TOOLS = defineToolFamily<typeof CHANGE_AVATAR_TOOL_SHAPES, AvatarDirectory>(CHANGE_AVATAR_TOOL_SHAPES, {
  [CHANGE_AVATAR_TOOL]: async (directory, from, { seed, ...parts }) => {
    const named = Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined)) as AgentFacePatch
    const request = { ...(seed ? { seed } : {}), ...(Object.keys(named).length > 0 ? { parts: named } : {}) }
    return { text: await directory.change(from, request), isError: false }
  },
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
