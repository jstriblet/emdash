import { createServer, connect as connectSocket, type Server } from 'node:net';
import type { OrchestratorHealth } from '@emdash/core/runtimes/orchestrator/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import {
  OrchestratorService,
  type CreateOrchestratorRuntime,
} from './orchestrator-service';

describe('OrchestratorService', () => {
  let remote: Server | undefined;
  let service: OrchestratorService | undefined;

  afterEach(async () => {
    await service?.dispose();
    await new Promise<void>((resolve) => remote?.close(() => resolve()) ?? resolve());
  });

  it('connects to Orc through a saved SSH connection', async () => {
    remote = createServer((socket) => {
      socket.once('data', () => {
        const body = JSON.stringify({
          status: 'ok',
          entries: 4,
          memories: 2,
          provider: 'codex',
          model: null,
          busy: false,
        });
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
      });
    });
    const remotePort = await listen(remote);
    const connect = vi.fn().mockResolvedValue('connected');
    const forwardOut = vi.fn(
      (
        _sourceHost: string,
        _sourcePort: number,
        targetHost: string,
        targetPort: number,
        callback: (error: Error | undefined, channel?: unknown) => void
      ) => {
        const channel = connectSocket(targetPort, targetHost);
        channel.once('connect', () => callback(undefined, channel));
        channel.once('error', (error) => callback(error));
      }
    );
    const ssh = {
      ssh: { connect },
      manager: { getProxy: () => ({ isConnected: true, client: { forwardOut } }) },
    } as unknown as SshServiceHandle;
    const createRuntime: CreateOrchestratorRuntime = (baseUrl = 'http://127.0.0.1:8790') => ({
      health: async () => {
        const response = await fetch(`${baseUrl}/health`);
        return (await response.json()) as OrchestratorHealth;
      },
      thread: vi.fn(),
      send: vi.fn(),
      workContracts: vi.fn(),
      createWorkContract: vi.fn(),
      updateWorkContract: vi.fn(),
      bindWorkContractExecution: vi.fn(),
    });
    service = new OrchestratorService(ssh, createRuntime, { remotePort });

    await expect(service.connect('thinkcenter')).resolves.toMatchObject({ status: 'ok' });
    expect(connect).toHaveBeenCalledWith('thinkcenter');
    expect(forwardOut).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      '127.0.0.1',
      remotePort,
      expect.any(Function)
    );
  });
});

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      resolve(address.port);
    });
  });
}
