import { describe, expect, it, vi } from 'vitest';
import { restoreOrchestratorConnection } from './orchestrator-auto-connect';

describe('restoreOrchestratorConnection', () => {
  it('connects the only saved machine when Orc is unreachable', async () => {
    const client = {
      health: vi.fn().mockRejectedValue(new Error('unreachable')),
      connect: vi.fn().mockResolvedValue({ status: 'ok' }),
    };

    await expect(restoreOrchestratorConnection(client, [{ id: 'thinkcenter' }])).resolves.toBe(
      true
    );
    expect(client.connect).toHaveBeenCalledWith({ connectionId: 'thinkcenter' });
  });

  it('does not reconnect when Orc is already reachable', async () => {
    const client = {
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
      connect: vi.fn(),
    };

    await expect(restoreOrchestratorConnection(client, [{ id: 'thinkcenter' }])).resolves.toBe(
      false
    );
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('tries saved machines until it reaches Orc', async () => {
    const client = {
      health: vi.fn().mockRejectedValue(new Error('unreachable')),
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error('not the Orc host'))
        .mockResolvedValueOnce({ status: 'ok' }),
    };

    await expect(
      restoreOrchestratorConnection(client, [{ id: 'one' }, { id: 'two' }])
    ).resolves.toBe(true);
    expect(client.connect).toHaveBeenNthCalledWith(1, { connectionId: 'one' });
    expect(client.connect).toHaveBeenNthCalledWith(2, { connectionId: 'two' });
  });
});
