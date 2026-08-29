import { execFile } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  OrchestratorHealth,
  OrchestratorForkUpdate,
  OrchestratorReply,
  OrchestratorThread,
} from '@emdash/core/runtimes/orchestrator/api';
import { OrchestratorRuntime } from '@emdash/core/runtimes/orchestrator/node';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';

const ORC_HOST = '127.0.0.1';
const ORC_PORT = 8790;
const execFileAsync = promisify(execFile);
const FORK_URL = 'https://github.com/jstriblet/emdash.git';
const FORK_BRANCH = 'phase-4-orchestrator-thread';

type OrchestratorServiceOptions = {
  baseUrl?: string;
  remoteHost?: string;
  remotePort?: number;
};

export class OrchestratorService {
  private runtime: OrchestratorRuntime;
  private server: Server | undefined;

  constructor(
    private readonly ssh: SshServiceHandle,
    private readonly options: OrchestratorServiceOptions = {}
  ) {
    this.runtime = new OrchestratorRuntime({ baseUrl: options.baseUrl });
  }

  async connect(connectionId: string): Promise<OrchestratorHealth> {
    await this.disposeTunnel();
    await this.ssh.ssh.connect(connectionId);
    const proxy = this.ssh.manager.getProxy(connectionId);
    if (!proxy?.isConnected) throw new Error('SSH connection is not available');

    const server = createServer((socket) => this.forwardSocket(connectionId, socket));
    this.server = server;
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, ORC_HOST, () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate the Orc forwarding port'));
          return;
        }
        resolve(address.port);
      });
    });

    this.runtime = new OrchestratorRuntime({ baseUrl: `http://${ORC_HOST}:${port}` });
    try {
      return await this.runtime.health();
    } catch (error) {
      await this.disposeTunnel();
      throw error;
    }
  }

  async updateFork(): Promise<OrchestratorForkUpdate> {
    if (!import.meta.env.DEV) {
      throw new Error('Source updates are only available in a development checkout');
    }
    const repositoryRoot = resolve(process.cwd(), '../..');
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only', FORK_URL, FORK_BRANCH], {
      cwd: repositoryRoot,
      timeout: 120_000,
    });
    const message = stdout.trim() || 'Fork is already up to date.';
    return { updated: !/already up[ -]to[ -]date/i.test(message), message };
  }

  health(): Promise<OrchestratorHealth> {
    return this.runtime.health();
  }

  thread(limit?: number): Promise<OrchestratorThread> {
    return this.runtime.thread(limit);
  }

  send(text: string): Promise<OrchestratorReply> {
    return this.runtime.send(text);
  }

  async dispose(): Promise<void> {
    await this.disposeTunnel();
  }

  private forwardSocket(connectionId: string, socket: Socket): void {
    const proxy = this.ssh.manager.getProxy(connectionId);
    if (!proxy?.isConnected) {
      socket.destroy(new Error('SSH connection is not available'));
      return;
    }
    proxy.client.forwardOut(
      socket.remoteAddress ?? ORC_HOST,
      socket.remotePort ?? 0,
      this.options.remoteHost ?? ORC_HOST,
      this.options.remotePort ?? ORC_PORT,
      (error, channel) => {
        if (error) {
          socket.destroy(error);
          return;
        }
        socket.pipe(channel).pipe(socket);
        channel.on('error', (cause: Error) => socket.destroy(cause));
        socket.on('error', () => channel.destroy());
      }
    );
  }

  private async disposeTunnel(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
