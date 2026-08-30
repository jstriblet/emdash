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

  it('does not guess among multiple machines', async () => {
    const client = { health: vi.fn(), connect: vi.fn() };

    await expect(
      restoreOrchestratorConnection(client, [{ id: 'one' }, { id: 'two' }])
    ).resolves.toBe(false);
    expect(client.health).not.toHaveBeenCalled();
  });
});
