import { describe, expect, it } from 'vitest'
import type { QuestionDirectory } from '../src/lib/questions-tool.ts'
import { installQuestionDirectory, questionDirectoryHandle } from '../src/lib/questions-tool.ts'
import { runSessionTool, sessionToolSpecs } from '../src/lib/session-tools.ts'

function recording(): QuestionDirectory & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = []
  const answer = (method: string) => async (from: string, input: unknown) => {
    calls.push([method, from, input])
    return `${method} ok`
  }
  return {
    calls,
    ask: answer('ask'),
    list: answer('list'),
    update: answer('update'),
    closeItem: answer('closeItem'),
    recordAnswer: answer('recordAnswer'),
  }
}

describe('questions tools', () => {
  it('are offered only with a directory, after the peer tools', () => {
    const names = sessionToolSpecs({ questions: recording(), write: false }).map((spec) => spec.name)
    expect(names).toEqual(['questions_ask', 'questions_list', 'questions_update', 'questions_close', 'questions_record_answer'])
    expect(sessionToolSpecs({ write: false })).toEqual([])
  })

  it('route each tool to its method with the caller id and parsed input', async () => {
    const directory = recording()
    const output = await runSessionTool({ questions: directory, write: false }, 's1', 'questions_close', { n: 2, reason: 'withdrawn' })
    expect(output).toEqual({ text: 'closeItem ok', isError: false })
    expect(directory.calls).toEqual([['closeItem', 's1', { n: 2, reason: 'withdrawn' }]])
  })

  it('refuse bad input before the directory sees it, and read a thrown refusal as the tool error', async () => {
    const directory = recording()
    const bad = await runSessionTool({ questions: directory, write: false }, 's1', 'questions_ask', { title: '', kind: 'poll' })
    expect(bad?.isError).toBe(true)
    expect(bad?.text).toContain('invalid arguments for questions_ask')
    expect(directory.calls).toEqual([])
    directory.update = async () => {
      throw new Error('#1 is not yours to edit')
    }
    expect(await runSessionTool({ questions: directory, write: false }, 's1', 'questions_update', { n: 1 })).toEqual({
      text: '#1 is not yours to edit',
      isError: true,
    })
  })

  it('resolve the own directory first and the installed one once it is gone', async () => {
    const own = recording()
    const installed = recording()
    let current: QuestionDirectory | undefined = own
    const handle = questionDirectoryHandle(() => current)
    installQuestionDirectory(installed)
    try {
      await handle.list('s1', {})
      current = undefined
      await handle.list('s1', {})
      expect(own.calls).toHaveLength(1)
      expect(installed.calls).toHaveLength(1)
    } finally {
      installQuestionDirectory(undefined)
    }
  })
})
