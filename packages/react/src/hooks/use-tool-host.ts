import { useEffect, useRef, useState } from 'react'
import type { SessionHandle } from '@workerdeck/client'
import { createToolCallHost, type ToolCallHostOptions, type ToolHostExecution } from '../lib/tool-host.ts'

export type UseToolCallHostOptions = ToolCallHostOptions & {
  enabled?: boolean
  historyLimit?: number
}

export function useToolCallHost(
  handle: SessionHandle | undefined,
  options: UseToolCallHostOptions = {},
): { executions: ToolHostExecution[] } {
  const [executions, setExecutions] = useState<ToolHostExecution[]>([])
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!handle || options.enabled === false) {
      return
    }
    const host = createToolCallHost(handle, {
      // Getters read the ref at call time, so inline objects and closures never resubscribe.
      get tools() {
        const base = optionsRef.current.tools
        const client = optionsRef.current.clientTools
        if (!client) {
          return base
        }
        const clientNames = Object.keys(client)
        return base ? [...new Set([...base, ...clientNames])] : clientNames
      },
      get clientTools() {
        return optionsRef.current.clientTools
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
        setExecutions((prev) => [...prev.filter((e) => e.executionId !== execution.executionId), execution].slice(-limit))
      },
    })
    return () => host.dispose()
  }, [handle, options.enabled])

  return { executions }
}
