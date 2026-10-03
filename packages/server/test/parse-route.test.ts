import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/lib/http.ts'
import { parseSessionRoute } from '../src/lib/parse-route.ts'

describe('parseSessionRoute', () => {
  it('does not read a path that merely starts with /sessions as a session', () => {
    expect(parseSessionRoute('/v1', '/v1/sessionsX')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessionsX/ws')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessions')).toEqual({ kind: 'collection' })
    expect(parseSessionRoute('/v1', '/v1/sessions/abc')).toEqual({ kind: 'session', id: 'abc' })
  })

  it('answers a malformed percent-escape as a 400, not an internal error', () => {
    const attempt = (): unknown => parseSessionRoute('/v1', '/v1/sessions/%E0%A4%A')
    expect(attempt).toThrow(HttpError)
    try {
      attempt()
    } catch (error) {
      expect((error as HttpError).status).toBe(400)
    }
    expect(() => parseSessionRoute('/v1', '/v1/sessions/abc/files/%ZZ')).toThrow(HttpError)
  })

  it('tags every sub-route with its kind', () => {
    expect(parseSessionRoute('/v1', '/v1/sessions/a/ws')).toEqual({ kind: 'ws', id: 'a' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/permissions/p%201')).toEqual({ kind: 'permission', id: 'a', permissionId: 'p 1' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/shells/s/kill')).toEqual({ kind: 'shells', id: 'a', shellId: 's', shellAction: 'kill' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/shells/s/nope')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessions/a/events/7/result')).toEqual({ kind: 'tool-result', id: 'a', resultSeq: 7 })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/mcp/plugin%3Agtm')).toEqual({ kind: 'mcp', id: 'a', mcpServer: 'plugin:gtm' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/peers')).toEqual({ kind: 'peers', id: 'a' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/tasks/background')).toEqual({ kind: 'background-task', id: 'a' })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/tasks/t%201/background')).toEqual({
      kind: 'background-task',
      id: 'a',
      backgroundTaskId: 't 1',
    })
    expect(parseSessionRoute('/v1', '/v1/sessions/a/peers/x')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessions/a/files/x/y.md')).toEqual({ kind: 'files', id: 'a', filePath: '/x/y.md' })
  })

  it('never reads an empty session id or permission id as the collection or the session', () => {
    expect(parseSessionRoute('/v1', '/v1/sessions//permissions/x')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessions//ws')).toBeNull()
    expect(parseSessionRoute('/v1', '/v1/sessions/a/permissions/')).toBeNull()
  })
})
