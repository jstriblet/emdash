import { describe, expect, it } from 'vitest';
import { selectWorkerConversation } from './worker-telemetry';

describe('selectWorkerConversation', () => {
  it('surfaces an awaiting-input worker ahead of an idle conversation', () => {
    const selected = selectWorkerConversation([
      {
        id: 'idle',
        providerId: 'codex',
        agentStatus: 'idle',
        lastInteractedAt: '2026-08-30T10:01:00Z',
      },
      {
        id: 'prompt',
        providerId: 'codex',
        agentStatus: 'awaiting-input',
        lastInteractedAt: '2026-08-30T10:00:00Z',
      },
    ]);

    expect(selected?.id).toBe('prompt');
  });
});
