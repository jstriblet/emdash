import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  OrchestratorHealth,
  OrchestratorExecutionLinkInput,
  OrchestratorForkUpdate,
  OrchestratorReply,
  OrchestratorThread,
  OrchestratorWorkContract,
  OrchestratorWorkContractInput,
  OrchestratorWorkContractUpdateInput,
} from '@emdash/core/runtimes/orchestrator/api';
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

export type OrchestratorRuntimeClient = {
  health(): Promise<OrchestratorHealth>;
  thread(limit?: number): Promise<OrchestratorThread>;
  send(text: string): Promise<OrchestratorReply>;
  workContracts(): Promise<{ workContracts: OrchestratorWorkContract[] }>;
  createWorkContract(contract: OrchestratorWorkContractInput): Promise<OrchestratorWorkContract>;
  updateWorkContract(
    contractId: string,
    update: OrchestratorWorkContractUpdateInput
  ): Promise<OrchestratorWorkContract>;
  bindWorkContractExecution(
    contractId: string,
    execution: OrchestratorExecutionLinkInput
  ): Promise<OrchestratorWorkContract>;
};

export type CreateOrchestratorRuntime = (baseUrl?: string) => OrchestratorRuntimeClient;

export class OrchestratorService {
  private runtime: OrchestratorRuntimeClient;
  private server: Server | undefined;
  private macBuild: ChildProcess | undefined;

  constructor(
    private readonly ssh: SshServiceHandle,
    private readonly createRuntime: CreateOrchestratorRuntime,
    private readonly options: OrchestratorServiceOptions = {}
  ) {
    this.runtime = createRuntime(options.baseUrl);
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

    this.runtime = this.createRuntime(`http://${ORC_HOST}:${port}`);
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

  async installMacApp(): Promise<OrchestratorForkUpdate> {
    if (!import.meta.env.DEV || process.platform !== 'darwin') {
      throw new Error('Mac app installation is only available from the macOS development app');
    }
    if (this.macBuild && this.macBuild.exitCode === null) {
      return { updated: false, message: 'The Mac app is already being built.' };
    }

    const repositoryRoot = resolve(process.cwd(), '../..');
    const artifact = resolve(repositoryRoot, 'apps/emdash-desktop/release/emdash-orc-arm64.dmg');
    const build = spawn(
      'pnpm',
      [
        '--dir',
        'apps/emdash-desktop',
        'run',
        'package:mac:orc',
        '--',
        '--arm64',
        '--publish',
        'never',
      ],
      { cwd: repositoryRoot, env: process.env, stdio: 'ignore' }
    );
    this.macBuild = build;
    build.once('exit', (code) => {
      this.macBuild = undefined;
      if (code !== 0) return;
      const opener = spawn('open', [artifact], { detached: true, stdio: 'ignore' });
      opener.unref();
    });
    build.once('error', () => {
      this.macBuild = undefined;
    });
    return {
      updated: true,
      message: 'Building the Mac app. Its installer will open when it is ready.',
    };
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

  workContracts(): Promise<{ workContracts: OrchestratorWorkContract[] }> {
    return this.runtime.workContracts();
  }

  createWorkContract(contract: OrchestratorWorkContractInput): Promise<OrchestratorWorkContract> {
    return this.runtime.createWorkContract(contract);
  }

  updateWorkContract(
    contractId: string,
    update: OrchestratorWorkContractUpdateInput
  ): Promise<OrchestratorWorkContract> {
    return this.runtime.updateWorkContract(contractId, update);
  }

  bindWorkContractExecution(
    contractId: string,
    execution: OrchestratorExecutionLinkInput
  ): Promise<OrchestratorWorkContract> {
    return this.runtime.bindWorkContractExecution(contractId, execution);
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
