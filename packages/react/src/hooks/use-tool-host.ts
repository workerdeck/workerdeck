import { useEffect, useRef, useState } from 'react'
import type { SessionHandle } from '@workerdeck/client'
import {
  createToolCallHost,
  type ToolCallHostOptions,
  type ToolHostExecution,
} from '../lib/tool-host.ts'

export type UseToolCallHostOptions = ToolCallHostOptions & {
  /** Turn the host off without unmounting. Default true. */
  enabled?: boolean
  /** How many recent executions to keep for rendering. Default 50. */
  historyLimit?: number
}

/**
 * React wrapper around {@link createToolCallHost}: subscribes while mounted and
 * exposes recent executions for rendering. All the logic lives in the
 * framework-free host — this only manages the subscription's lifetime.
 */
export function useToolCallHost(
  handle: SessionHandle | undefined,
  options: UseToolCallHostOptions = {},
): { executions: ToolHostExecution[] } {
  const [executions, setExecutions] = useState<ToolHostExecution[]>([])
  // Read options at call time so re-renders never tear down the subscription.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!handle || options.enabled === false) return
    const host = createToolCallHost(handle, {
      // Delegate every option through the ref, so a caller passing inline
      // objects/closures (the common case) doesn't resubscribe each render.
      get tools() {
        return optionsRef.current.tools
      },
      get timeoutMs() {
        return optionsRef.current.timeoutMs
      },
      get memoryLimitBytes() {
        return optionsRef.current.memoryLimitBytes
      },
      get loadEngine() {
        return optionsRef.current.loadEngine
      },
      get execute() {
        return optionsRef.current.execute
      },
      get fetchText() {
        return optionsRef.current.fetchText
      },
      onExecution: (execution) => {
        optionsRef.current.onExecution?.(execution)
        const limit = optionsRef.current.historyLimit ?? 50
        setExecutions((prev) => [
          ...prev.filter((e) => e.executionId !== execution.executionId),
          execution,
        ].slice(-limit))
      },
    })
    return () => host.dispose()
  }, [handle, options.enabled])

  return { executions }
}
