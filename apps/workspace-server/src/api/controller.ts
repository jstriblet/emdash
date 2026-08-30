import crypto from 'node:crypto';
import net from 'node:net';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { parseAbsolute } from '@emdash/core/primitives/path/api';
import type { HostDependenciesContract } from '@emdash/core/services/host-dependencies/api';
import {
  negotiateProtocol,
  PROTOCOL_VERSION,
  workspaceWireContract,
} from '@emdash/core/workspace-server';
import { err, ok } from '@emdash/shared';
import { createController, forwardContractImpl, type ContractImpl } from '@emdash/wire/rpc';
import type { ContractClient } from '@emdash/wire/rpc';
import type { WorkspaceServerRuntimeClients } from '../gateway/workspace-workers';

export type WorkspaceWireControllerDeps = {
  runtimes: WorkspaceServerRuntimeClients;
  hostDependencies: ContractClient<HostDependenciesContract>;
  appVersion?: string;
  daemonId?: string;
  startedAt?: number;
};

const defaultStartedAt = Date.now();
const defaultDaemonId = crypto.randomUUID();
export function createWorkspaceWireController(deps: WorkspaceWireControllerDeps) {
  const appVersion = deps.appVersion ?? '0.0.0';
  const daemonId = deps.daemonId ?? defaultDaemonId;
  const startedAt = deps.startedAt ?? defaultStartedAt;

  const findManualRun = async (executionId: string) => {
    const listed = await deps.runtimes.automations.listRuns({
      automationId: executionId,
      limit: 10,
    });
    if (!listed.success) return orchestrationFailure(listed.error);
    return ok(listed.data.runs.find((run) => run.triggerKind === 'manual') ?? null);
  };

  const inspectExecution = async (executionId: string) => {
    const found = await findManualRun(executionId);
    if (!found.success) return err(found.error);
    if (found.data === null) return ok(null);
    const run = found.data;
    if (!run.conversationId) return ok({ run, worker: null });
    const conversationId = run.conversationId;
    const [sessions, agentStates, output] = await Promise.all([
      deps.runtimes.tuiAgents.sessions.state(undefined, 'list').snapshot(),
      deps.runtimes.tuiAgents.agentStates.state(undefined, 'list').snapshot(),
      deps.runtimes.tuiAgents.output.handle({ conversationId }).snapshot(),
    ]);
    const session = sessions.data[conversationId] ?? null;
    const agentState = agentStates.data[conversationId] ?? null;
    const status =
      agentState?.status === 'awaiting-input'
        ? ('awaiting-input' as const)
        : agentState?.status === 'completed'
          ? ('completed' as const)
          : agentState?.status === 'error'
            ? ('failed' as const)
            : session?.status === 'exited'
              ? ('exited' as const)
              : !session && !agentState
                ? ('exited' as const)
                : session?.status === 'starting'
                  ? ('starting' as const)
                  : ('running' as const);
    return ok({
      run,
      worker: {
        status,
        session,
        agentState,
        outputTail: output.data.text.slice(-64_000),
      },
    });
  };

  return createController(workspaceWireContract, {
    health: () => ({
      status: 'ok' as const,
      version: appVersion,
      uptimeMs: Date.now() - startedAt,
      protocolVersion: PROTOCOL_VERSION,
    }),
    initialize: ({ protocolVersion }) => {
      const result = negotiateProtocol(protocolVersion, PROTOCOL_VERSION);
      if (!result.compatible) {
        return err({
          type: 'protocol-incompatible' as const,
          action: result.action,
          clientProtocolVersion: result.clientProtocolVersion,
          serverProtocolVersion: result.serverProtocolVersion,
        });
      }
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        agreedVersion: result.agreedVersion,
        agreedMinor: result.agreedMinor,
        server: {
          appVersion,
          daemonId,
          startedAt,
        },
      });
    },
    acp: {
      ...forwardContractImpl(workspaceWireContract.acp, deps.runtimes.acp),
      sendPrompt: (input, meta) =>
        deps.runtimes.acp.sendPrompt(input, { signal: meta.signal, timeoutMs: 0 }),
    },
    agentConfig: forwardContractImpl(workspaceWireContract.agentConfig, deps.runtimes.agentConfig),
    automations: forwardContractImpl(workspaceWireContract.automations, deps.runtimes.automations),
    conversations: forwardContractImpl(
      workspaceWireContract.conversations,
      deps.runtimes.conversations
    ),
    fileSearch: forwardContractImpl(workspaceWireContract.fileSearch, deps.runtimes.fileSearch),
    files: forwardContractImpl(workspaceWireContract.files, deps.runtimes.files),
    git: forwardContractImpl(workspaceWireContract.git, deps.runtimes.git),
    hostSettings: forwardContractImpl(
      workspaceWireContract.hostSettings,
      deps.runtimes.hostSettings
    ),
    scripts: forwardContractImpl(workspaceWireContract.scripts, deps.runtimes.scripts),
    resourceUsage: forwardContractImpl(
      workspaceWireContract.resourceUsage,
      deps.runtimes.resourceUsage
    ),
    terminals: forwardContractImpl(workspaceWireContract.terminals, deps.runtimes.terminals),
    tuiAgents: forwardContractImpl(workspaceWireContract.tuiAgents, deps.runtimes.tuiAgents),
    workspaceRegistry: forwardContractImpl(
      workspaceWireContract.workspaceRegistry,
      deps.runtimes.workspaceRegistry
    ),
    hostDependencies: forwardContractImpl(
      workspaceWireContract.hostDependencies,
      deps.hostDependencies
    ),
    portForwards: createPortForwardsController(),
    orchestration: {
      launch: async (input) => {
        const repository = parsePosixPath(input.repositoryPath);
        const worktreePoolPath = parsePosixPath(`${input.worktreeRoot}/.orc-worktree`);
        const deployed = await deps.runtimes.automations.deploy({
          automationId: input.executionId,
          revision: 1,
          enabled: true,
          name: `Orc: ${input.goal.slice(0, 80)}`,
          schedule: { expr: '0 0 1 1 *', tz: 'UTC' },
          agent: {
            type: 'tui',
            title: input.goal.slice(0, 120),
            start: {
              providerId: input.provider,
              model: input.model,
              initialPrompt: input.goal,
              autoApprove: true,
            },
          },
          workspace: {
            kind: 'worktree',
            repository: { host: LOCAL_HOST_REF, path: repository },
            worktreePoolPath,
            baseRemote: input.baseRemote,
            preservePatterns: [],
            git: {
              kind: 'create-branch',
              fromBranch: { type: 'local', branch: input.baseBranch },
              pushRemote: null,
            },
          },
        });
        if (!deployed.success) return orchestrationFailure(deployed.error);
        const started = await deps.runtimes.automations.startRun({
          automationId: input.executionId,
        });
        return started.success ? ok(started.data.run) : orchestrationFailure(started.error);
      },
      get: async ({ executionId }) => {
        return findManualRun(executionId);
      },
      inspect: async ({ executionId }) => inspectExecution(executionId),
      sendInput: async ({ executionId, data }) => {
        const found = await findManualRun(executionId);
        if (!found.success) return err(found.error);
        if (!found.data?.conversationId) {
          return orchestrationFailure(new Error('Worker conversation is not available'));
        }
        const sent = await deps.runtimes.tuiAgents.sendInput({
          conversationId: found.data.conversationId,
          data,
        });
        if (!sent.success) return orchestrationFailure(sent.error);
        const inspected = await inspectExecution(executionId);
        if (!inspected.success) return err(inspected.error);
        return inspected.data
          ? ok(inspected.data)
          : orchestrationFailure(new Error('Worker execution disappeared'));
      },
      archive: async ({ executionId }) => {
        const found = await findManualRun(executionId);
        if (!found.success) return err(found.error);
        const conversationId = found.data?.conversationId;
        if (!conversationId) return ok(undefined);
        const deleted = await deps.runtimes.tuiAgents.delete({ conversationId });
        if (!deleted.success) return orchestrationFailure(deleted.error);
        const conversationDeleted = await deps.runtimes.conversations.delete({ conversationId });
        return conversationDeleted.success
          ? ok(undefined)
          : orchestrationFailure(conversationDeleted.error);
      },
      cancel: async ({ executionId }) => {
        const listed = await deps.runtimes.automations.listRuns({
          automationId: executionId,
          limit: 10,
        });
        if (!listed.success) return orchestrationFailure(listed.error);
        const active = listed.data.runs.find(
          (run) => run.triggerKind === 'manual' && run.finishedAt === null
        );
        if (!active) return ok(undefined);
        const cancelled = await deps.runtimes.automations.cancelRun({
          automationId: executionId,
          runId: active.id,
        });
        return cancelled.success ? ok(undefined) : orchestrationFailure(cancelled.error);
      },
    },
  });
}

function parsePosixPath(value: string) {
  const parsed = parseAbsolute(value, {
    profile: { style: 'posix', unicodeNormalization: 'preserve' },
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

function orchestrationFailure(error: unknown) {
  return err({
    type: 'operation-failed' as const,
    message:
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error),
  });
}

function createPortForwardsController(): NonNullable<
  ContractImpl<typeof workspaceWireContract>['portForwards']
> {
  return {
    inspect: async ({ port }) => {
      try {
        const results = await Promise.all([
          probeLoopbackPort('127.0.0.1', port),
          probeLoopbackPort('::1', port),
        ]);
        const families = results.flatMap((result, index) =>
          result ? ([index === 0 ? 'ipv4' : 'ipv6'] as const) : []
        );
        return ok({
          listening: families.length > 0,
          families,
        });
      } catch (error) {
        return err({
          type: 'io' as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

function probeLoopbackPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => finish(false), 500);
    const finish = (listening: boolean) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
