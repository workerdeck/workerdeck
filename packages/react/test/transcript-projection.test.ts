import { describe, expect, it } from 'vitest'

import { projectTranscript } from '../src/lib/transcript-projection.ts'
import { initialTranscriptState } from '../src/lib/transcript.ts'

describe('projectTranscript', () => {
  it('drops absent fields, sorts keys and leaves the catalog out', () => {
    const projection = projectTranscript({
      ...initialTranscriptState,
      model: 'm',
      cwd: undefined,
      models: [],
      items: [{ kind: 'assistant_text', id: 'a', text: 'hi', streaming: false, parentToolUseId: null }],
    })
    expect(Object.keys(projection)).toEqual(['items', 'lastSeq', 'model', 'pendingApprovals', 'status', 'totalCostUsd'])
    expect(projection.items).toEqual([{ id: 'a', kind: 'assistant_text', streaming: false, text: 'hi' }])
  })
})
