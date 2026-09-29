import { errorMessage } from '@workerdeck/protocol'
import { z } from 'zod'

export type GatewayToolShape = { readonly description: string; readonly shape: z.ZodRawShape }

export type GatewayToolOutput = { text: string; isError: boolean }

export type GatewayToolSpec<N extends string = string> = { name: N; description: string; inputSchema: Record<string, unknown> }

export type GatewayToolHandlers<S extends Record<string, GatewayToolShape>, D> = {
  [K in keyof S]: (directory: D, from: string, input: z.infer<z.ZodObject<S[K]['shape']>>) => Promise<GatewayToolOutput>
}

export type GatewayToolFamily<S extends Record<string, GatewayToolShape>, D> = {
  readonly names: (keyof S & string)[]
  is(name: string): name is keyof S & string
  specs(names?: readonly (keyof S & string)[]): GatewayToolSpec<keyof S & string>[]
  run(directory: D, from: string, name: keyof S & string, args: unknown): Promise<GatewayToolOutput>
}

export type GlobalSlot<T> = { install(value: T | undefined): void; installed(): T | undefined }

export function defineToolFamily<S extends Record<string, GatewayToolShape>, D>(
  shapes: S,
  handlers: GatewayToolHandlers<S, D>,
): GatewayToolFamily<S, D> {
  const names = Object.keys(shapes) as (keyof S & string)[]
  return {
    names,
    is: (name): name is keyof S & string => Object.hasOwn(shapes, name),
    specs: (subset = names) => subset.map((name) => gatewayToolSpec(name, shapes[name]!)),
    run: async (directory, from, name, args) => {
      try {
        const { shape } = shapes[name]!
        if (Object.keys(shape).length === 0) {
          return await handlers[name](directory, from, {} as never)
        }
        const input = z.object(shape).safeParse(args ?? {})
        if (!input.success) {
          return invalidArguments(
            name,
            input.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '),
          )
        }
        return await handlers[name](directory, from, input.data as never)
      } catch (error) {
        return { text: errorMessage(error), isError: true }
      }
    },
  }
}

export function gatewayToolSpec<N extends string>(name: N, tool: GatewayToolShape): GatewayToolSpec<N> {
  return { name, description: tool.description, inputSchema: z.toJSONSchema(z.object(tool.shape)) as Record<string, unknown> }
}

export function invalidArguments(name: string, detail: string): GatewayToolOutput {
  return { text: `invalid arguments for ${name}: ${detail}`, isError: true }
}

// Keyed through `Symbol.for`, so two module generations in one process (a hot reload) share the one slot.
export function globalSlot<T>(key: string): GlobalSlot<T> {
  const slot = Symbol.for(key)
  const store = globalThis as Record<symbol, unknown>
  return {
    install: (value) => {
      store[slot] = value
    },
    installed: () => store[slot] as T | undefined,
  }
}

// Resolved per call: the caller's own directory first, the process-wide slot once that one is gone.
export function lateBoundDirectory<T extends object>(
  methods: readonly (keyof T & string)[],
  slot: GlobalSlot<T>,
  own: (() => T | undefined) | undefined,
  unavailable: string,
): T {
  const resolve = (): T => {
    const directory = own?.() ?? slot.installed()
    if (!directory) {
      throw new Error(unavailable)
    }
    return directory
  }
  const handle: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const method of methods) {
    handle[method] = async (...args) => {
      const directory = resolve()
      const fn = directory[method]
      return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).apply(directory, args) : undefined
    }
  }
  return handle as T
}
