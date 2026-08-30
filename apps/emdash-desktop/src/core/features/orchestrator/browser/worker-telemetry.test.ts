import { describe, expect, it } from 'vitest';
import {
  flushTerminalWrites,
  rawTerminalPromptExcerpt,
  selectWorkerConversation,
  terminalPromptExcerpt,
} from './worker-telemetry';

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

describe('rawTerminalPromptExcerpt', () => {
  it('returns a redacted prompt from the authoritative TUI output', () => {
    const excerpt = rawTerminalPromptExcerpt(
      'Starting agent\r\n\u001b[33mDo you trust the authors of this folder?\u001b[0m\r\ntoken: ghp_secret'
    );

    expect(excerpt).toContain('Do you trust the authors of this folder?');
    expect(excerpt).toContain('[REDACTED]');
    expect(excerpt).not.toContain('ghp_secret');
  });
});

describe('terminalPromptExcerpt', () => {
  it('returns a redacted tail containing the interactive prompt', () => {
    const lines = [
      'earlier output',
      'Do you trust the authors of this folder?',
      'token: ghp_secret',
    ];
    const excerpt = terminalPromptExcerpt({
      length: lines.length,
      getLine: (index) => ({ translateToString: () => lines[index] ?? '' }),
    });

    expect(excerpt).toContain('Do you trust the authors of this folder?');
    expect(excerpt).toContain('[REDACTED]');
    expect(excerpt).not.toContain('ghp_secret');
  });
});

describe('flushTerminalWrites', () => {
  it('waits until xterm has parsed queued output', async () => {
    let parsed = false;
    await flushTerminalWrites({
      write: (_data, callback) => {
        parsed = true;
        callback?.();
      },
    });
    expect(parsed).toBe(true);
  });
});
