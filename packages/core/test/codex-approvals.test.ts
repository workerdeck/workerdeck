import { describe, expect, it, vi } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner: approvals and user input', () => {
  it('surfaces a command escalation as permission_requested and accepts on allow', async () => {
    const peer = scriptedPeer()
    let approvalResponse: unknown
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      peer.emit('item/started', {
        threadId: 'thread-1',
        turnId: 't1',
        item: { id: 'exec-1', type: 'commandExecution', command: 'printf x > /tmp/p.txt', status: 'inProgress' },
      })
      void peer
        .serverRequest('item/commandExecution/requestApproval', {
          threadId: 'thread-1',
          turnId: 't1',
          itemId: 'exec-1',
          command: 'printf x > /tmp/p.txt',
          cwd: '/tmp',
          reason: 'command failed; retry without sandbox?',
          availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }, 'cancel'],
        })
        .then((response) => {
          approvalResponse = response
          peer.emit('item/completed', {
            threadId: 'thread-1',
            turnId: 't1',
            item: {
              id: 'exec-1',
              type: 'commandExecution',
              command: 'printf x > /tmp/p.txt',
              aggregatedOutput: '',
              exitCode: 0,
              status: 'completed',
            },
          })
          peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
        })
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(ofType(events, 'permission_requested')).toHaveLength(1))

    const request = ofType(events, 'permission_requested')[0]!.request
    expect(request.toolName).toBe('CodexCommand')
    expect(request.title).toBe('command failed; retry without sandbox?')
    expect(request.decisionReason).toBe('command failed; retry without sandbox?')
    expect(request.input).toMatchObject({ command: 'printf x > /tmp/p.txt', cwd: '/tmp' })
    expect(request.expiresAt).toBeGreaterThan(Date.now())
    const use = ofType(events, 'assistant_message')
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .find((b) => b.type === 'tool_use') as { id: string }
    expect(request.toolUseId).toBe(use.id)
    expect(runner.status).toBe('awaiting_approval')
    expect(runner.info().pendingPermissionCount).toBe(1)
    expect(runner.pendingApprovals.map((r) => r.id)).toEqual([request.id])

    expect(runner.resolvePermission(request.id, { behavior: 'allow' })).toBe(true)
    await run
    expect(approvalResponse).toEqual({ decision: 'accept' })
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'client',
    })
    expect(runner.status).toBe('idle')
    expect(runner.info().pendingPermissionCount).toBe(0)
    expect(runner.resolvePermission(request.id, { behavior: 'allow' })).toBe(false)
  })

  it('denies with decline, cancels only when interrupting, and never invents an accept', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const deny = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c1',
      command: 'rm -rf /',
      availableDecisions: ['accept', 'cancel'],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, {
      behavior: 'deny',
      message: 'no thanks',
    })
    await expect(deny).resolves.toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'client',
      message: 'no thanks',
    })

    const cancel = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c2',
      command: 'sleep 999',
      availableDecisions: ['accept', 'cancel'],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny', interrupt: true })
    await expect(cancel).resolves.toEqual({ decision: 'cancel' })

    const noAccept = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c3',
      command: 'echo hi',
      availableDecisions: ['acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } }, 'cancel'],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await expect(noAccept).resolves.toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
      message: expect.stringContaining('no plain accept'),
    })

    await expect(peer.serverRequest('account/chatgptAuthTokens/refresh', {})).rejects.toMatchObject({
      code: -32601,
    })
  })

  it('times out an unanswered approval without wedging the turn', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      void peer
        .serverRequest('item/fileChange/requestApproval', {
          threadId: 'thread-1',
          turnId: 't1',
          itemId: 'f1',
          grantRoot: '/tmp/project',
        })
        .then((response) => {
          expect(response).toEqual({ decision: 'decline' })
          peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
        })
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      approvalTimeoutMs: 25,
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'permission_requested')[0]!.request).toMatchObject({
      toolName: 'CodexFileChange',
      input: { grantRoot: '/tmp/project' },
    })
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'timeout',
      message: 'Approval timed out',
    })
    expect(runner.status).toBe('idle')
    scriptTurn(
      peer,
      (emit, turnId) => {
        emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      },
      't2',
    )
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
  })

  it('maps requestUserInput onto the AskUserQuestion convention, with question policies', async () => {
    const QUESTIONS = {
      threadId: 'thread-1',
      turnId: 't1',
      itemId: 'q-item',
      questions: [
        {
          id: 'q1',
          header: 'Auth',
          question: 'Which auth method?',
          options: [
            { label: 'OAuth', description: 'browser flow' },
            { label: 'API key', description: 'env var' },
          ],
        },
      ],
    }
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()

    const asked = peer.serverRequest('item/tool/requestUserInput', QUESTIONS)
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    const request = runner.pendingApprovals[0]!
    expect(request.toolName).toBe('AskUserQuestion')
    expect(request.input).toEqual({
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          options: [
            { label: 'OAuth', description: 'browser flow' },
            { label: 'API key', description: 'env var' },
          ],
        },
      ],
    })
    runner.resolvePermission(request.id, {
      behavior: 'allow',
      updatedInput: { answers: { 'Which auth method?': 'API key' } },
    })
    await expect(asked).resolves.toEqual({ answers: { q1: { answers: ['API key'] } } })

    const autoPeer = scriptedPeer()
    scriptTurn(autoPeer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const auto = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      questionBehavior: 'auto',
      connectFn: autoPeer.connectFn,
    })
    const autoEvents = collect(auto)
    await auto.start()
    await expect(autoPeer.serverRequest('item/tool/requestUserInput', QUESTIONS)).resolves.toEqual({
      answers: { q1: { answers: ['OAuth'] } },
    })
    expect(auto.pendingApprovals).toHaveLength(0)
    expect(ofType(autoEvents, 'permission_resolved')[0]).toMatchObject({
      behavior: 'allow',
      resolvedBy: 'policy',
    })

    const denyPeer = scriptedPeer()
    scriptTurn(denyPeer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const denied = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      questionBehavior: 'deny',
      connectFn: denyPeer.connectFn,
    })
    const deniedEvents = collect(denied)
    await denied.start()
    await expect(denyPeer.serverRequest('item/tool/requestUserInput', QUESTIONS)).resolves.toEqual({
      answers: {},
    })
    expect(ofType(deniedEvents, 'permission_resolved')[0]).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
    })
  })

  it('grants exactly the requested permission profile on allow, nothing on deny or teardown', async () => {
    const PROFILE = { fileSystem: { write: ['/tmp/project'] } }
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const granted = peer.serverRequest('item/permissions/requestApproval', {
      threadId: 'thread-1',
      itemId: 'p1',
      permissions: PROFILE,
      reason: 'need to write build output',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    expect(runner.pendingApprovals[0]).toMatchObject({
      toolName: 'CodexPermissions',
      title: 'need to write build output',
    })
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await expect(granted).resolves.toEqual({ permissions: PROFILE })

    const refused = peer.serverRequest('item/permissions/requestApproval', {
      threadId: 'thread-1',
      itemId: 'p2',
      permissions: PROFILE,
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny' })
    await expect(refused).resolves.toEqual({ permissions: {} })

    const elicited = peer.serverRequest('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      serverName: 'deepwiki',
      message: 'API token?',
      mode: 'form',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    expect(runner.pendingApprovals[0]!.toolName).toBe('CodexMcpElicitation')
    runner.resolvePermission(runner.pendingApprovals[0]!.id, {
      behavior: 'allow',
      updatedInput: { token: 'abc' },
    })
    await expect(elicited).resolves.toEqual({ action: 'accept', content: { token: 'abc' } })

    const orphan = peer.serverRequest('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      serverName: 'deepwiki',
      message: 'still there?',
      mode: 'form',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.close()
    await expect(orphan).resolves.toEqual({ action: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
      message: 'Session closed',
    })
  })

  it('sweeps approvals the turn outlived, and honors serverRequest/resolved', async () => {
    const peer = scriptedPeer()
    const responses: unknown[] = []
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      void peer
        .serverRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', itemId: 'c1', command: 'a' }, 'wire-7')
        .then((r) => responses.push(r))
      void peer
        .serverRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', itemId: 'c2', command: 'b' }, 'wire-8')
        .then((r) => responses.push(r))
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(2))

    peer.emit('serverRequest/resolved', { threadId: 'thread-1', requestId: 'wire-7' })
    expect(runner.pendingApprovals).toHaveLength(1)
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      resolvedBy: 'policy',
      message: 'resolved by codex',
    })

    peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
    await run
    expect(runner.pendingApprovals).toHaveLength(0)
    expect(ofType(events, 'permission_resolved')[1]).toMatchObject({
      resolvedBy: 'policy',
      message: 'Turn ended',
    })
    expect(responses).toEqual([{ decision: 'decline' }, { decision: 'decline' }])
    expect(runner.status).toBe('idle')
  })
})
