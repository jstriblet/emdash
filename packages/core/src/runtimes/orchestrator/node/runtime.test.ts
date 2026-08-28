import { describe, expect, it, vi } from 'vitest';
import { OrchestratorRuntime } from './runtime';

describe('OrchestratorRuntime', () => {
  it('reads and validates the shared thread', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        turns: [
          {
            id: 1,
            ts: '2026-08-28T10:00:00-04:00',
            surface: 'imessage',
            role: 'user',
            content: 'hello',
          },
        ],
      })
    );
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test/', fetch });

    await expect(runtime.thread(25)).resolves.toMatchObject({ turns: [{ content: 'hello' }] });
    expect(fetch).toHaveBeenCalledWith('http://orc.test/thread?limit=25', expect.any(Object));
  });

  it('marks outbound messages as coming from Emdash', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ entry_id: 2, reply: 'hi' }));
    const runtime = new OrchestratorRuntime({ fetch });

    await runtime.send('hello');

    const init = fetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ surface: 'emdash', text: 'hello' });
  });

  it('reports the configured endpoint when the core is unreachable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://thinkcenter:8790', fetch });

    await expect(runtime.health()).rejects.toThrow(
      'Unable to reach Orc at http://thinkcenter:8790'
    );
  });
});
