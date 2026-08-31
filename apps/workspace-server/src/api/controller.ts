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
  enableOrcCallbacks?: boolean;
  enableOrcActionConsumer?: boolean;
  orcActionSignal?: AbortSignal;
  loadOrcExecutions?: () => Promise<
    Array<{ conversationId: string; executionId: string; projectId: string }>
  >;
};

const defaultStartedAt = Date.now();
const defaultDaemonId = crypto.randomUUID();
const ansiEscapePattern =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

function cleanWorkerText(value: string): string {
  return value.replace(ansiEscapePattern, '').replace(/\r/g, '').trim();
}

export function orcWorkerEventId(input: {
  executionId: string;
  conversationId: string;
  status: string;
  sourceSequence: number;
  message: string;
}): string {
  const fingerprint = crypto.createHash('sha256').update(input.message).digest('hex');
  return crypto
    .createHash('sha256')
    .update(
      `${input.executionId}\0${input.conversationId}\0${input.status}\0${input.sourceSequence}\0${fingerprint}`
    )
    .digest('hex');
}

function orcCallbackHeaders(): Record<string, string> {
  const token = process.env.ORC_CALLBACK_TOKEN;
  return token
    ? { 'content-type': 'application/json', 'x-orc-callback-token': token }
    : { 'content-type': 'application/json' };
}

export function isInteractiveTerminalPrompt(value: string): boolean {
  const compact = cleanWorkerText(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9?]/g, '');
  return (
    (compact.includes('quicksafetycheck') && compact.includes('entertoconfirm')) ||
    compact.endsWith('pressentertocontinue') ||
    compact.endsWith('continue?yn')
  );
}

export function createWorkspaceWireController(deps: WorkspaceWireControllerDeps) {
  const appVersion = deps.appVersion ?? '0.0.0';
  const daemonId = deps.daemonId ?? defaultDaemonId;
  const startedAt = deps.startedAt ?? defaultStartedAt;
  const orcExecutions = new Map<
    string,
    { executionId: string; projectId: string; lastStatus?: string }
  >();
  const pendingOrcExecutions = new Map<string, string>();
  const watchedOrcConversations = new Set<string>();
  const pushedPromptFingerprints = new Map<string, string>();
  const loadOrcExecutions =
    deps.loadOrcExecutions ??
    (async () => {
      const response = await fetch('http://127.0.0.1:8790/work-contracts');
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        work_contracts?: Array<{
          state?: string;
          executions?: Array<{
            execution_id?: string;
            project_id?: string;
            session_id?: string | null;
            state?: string;
          }>;
        }>;
      };
      return (payload.work_contracts ?? []).flatMap((contract) => {
        const execution = contract.executions?.at(-1);
        if (
          !execution?.session_id ||
          !execution.execution_id ||
          !execution.project_id ||
          contract.state === 'completed' ||
          contract.state === 'failed' ||
          execution.state === 'completed' ||
          execution.state === 'failed'
        ) {
          return [];
        }
        return [
          {
            conversationId: execution.session_id,
            executionId: execution.execution_id,
            projectId: execution.project_id,
          },
        ];
      });
    });

  const pushBlockedPrompt = async (
    conversationId: string,
    execution: { executionId: string; projectId: string },
    message: string,
    provider?: string,
    sourceSequence?: number
  ) => {
    const fingerprint = crypto.createHash('sha256').update(message).digest('hex');
    if (pushedPromptFingerprints.get(execution.executionId) === fingerprint) return;
    pushedPromptFingerprints.set(execution.executionId, fingerprint);
    try {
      const response = await fetch(
        `http://127.0.0.1:8790/workers/${encodeURIComponent(execution.executionId)}/telemetry`,
        {
          method: 'POST',
          headers: orcCallbackHeaders(),
          body: JSON.stringify({
            schema_version: 1,
            event_id: orcWorkerEventId({
              executionId: execution.executionId,
              conversationId,
              status: 'blocked',
              sourceSequence: sourceSequence ?? 0,
              message,
            }),
            source_sequence: sourceSequence,
            incarnation_id: conversationId,
            emdash_task_id: execution.executionId,
            execution_id: execution.executionId,
            project_id: execution.projectId,
            conversation_id: conversationId,
            provider,
            status: 'blocked',
            notification_type: 'elicitation_dialog',
            prompt_excerpt: message,
            observed_at: new Date().toISOString(),
          }),
        }
      );
      if (!response.ok) pushedPromptFingerprints.delete(execution.executionId);
    } catch {
      // Retained output is inspected again by reconciliation; do not suppress this prompt.
      pushedPromptFingerprints.delete(execution.executionId);
    }
  };

  const watchInteractiveTerminalPrompts = (
    conversationId: string,
    execution: { executionId: string; projectId: string }
  ) => {
    if (!deps.enableOrcCallbacks || watchedOrcConversations.has(conversationId)) return;
    watchedOrcConversations.add(conversationId);
    const output = deps.runtimes.tuiAgents.output.handle({ conversationId });
    const inspectCurrentPrompt = () => {
      void output.snapshot().then(async (snapshot) => {
        const message = cleanWorkerText(snapshot.data.text.slice(-4000));
        if (!isInteractiveTerminalPrompt(message)) return;
        const states = await deps.runtimes.tuiAgents.agentStates
          .state(undefined, 'list')
          .snapshot();
        const state = states.data[conversationId];
        await pushBlockedPrompt(
          conversationId,
          execution,
          message,
          state?.providerId,
          state?.updatedAt
        );
      });
    };
    void output.asLiveSource().subscribe(inspectCurrentPrompt);
    // Startup dialogs can render before the execution is linked and the live subscription is
    // installed. Inspect the retained snapshot once so those prompts are still pushed to Orc.
    inspectCurrentPrompt();
  };

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

  const archiveExecution = async (executionId: string) => {
    const found = await findManualRun(executionId);
    if (!found.success) return err(found.error);
    const run = found.data;
    if (!run) return ok(undefined);
    const conversationId = run.conversationId;
    if (conversationId) {
      const states = await deps.runtimes.tuiAgents.agentStates.state(undefined, 'list').snapshot();
      if (states.data[conversationId]) {
        const deleted = await deps.runtimes.tuiAgents.delete({ conversationId });
        if (!deleted.success) return orchestrationFailure(deleted.error);
      }
      const records = await deps.runtimes.conversations.records.state(undefined, 'list').snapshot();
      if (records.data[conversationId]) {
        const conversationDeleted = await deps.runtimes.conversations.delete({ conversationId });
        if (!conversationDeleted.success) return orchestrationFailure(conversationDeleted.error);
      }
    }
    const workspaceDeleted = await deps.runtimes.workspaceRegistry.deleteWorktree({
      workspaceId: run.id,
      deleteBranch: true,
    });
    return workspaceDeleted.success ? ok(undefined) : orchestrationFailure(workspaceDeleted.error);
  };

  const restartExecution = async (executionId: string, goal: string) => {
    const found = await findManualRun(executionId);
    if (!found.success) return err(found.error);
    const conversationId = found.data?.conversationId;
    if (!conversationId) {
      return orchestrationFailure(new Error('Worker conversation is not available'));
    }
    const records = await deps.runtimes.conversations.records.state(undefined, 'list').snapshot();
    const record = records.data[conversationId];
    if (!record) return orchestrationFailure(new Error('Worker conversation record is missing'));
    const config = record.config;
    const resumed = await deps.runtimes.tuiAgents.resume({
      conversationId,
      providerId: record.provider,
      cwd: record.cwd,
      sessionId: record.providerSessionId,
      chosenSessionId: null,
      model: typeof config.model === 'string' ? config.model : null,
      initialPrompt: goal,
      autoApprove: config.autoApprove === true,
      trustWorkspace: config.trustWorkspace === true,
      cols: 120,
      rows: 40,
    });
    return resumed.success ? ok(undefined) : orchestrationFailure(resumed.error);
  };

  const consumeOrcAction = async () => {
    const claimed = await fetch('http://127.0.0.1:8790/actions/claim', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!claimed.ok) return;
    const { action } = (await claimed.json()) as {
      action?: Record<string, string> | null;
    };
    if (!action) return;
    let outcome;
    if (action.kind === 'send_worker_input') {
      const found = await findManualRun(action.execution_id);
      if (!found.success || !found.data?.conversationId) {
        outcome = orchestrationFailure(new Error('Worker conversation is not available'));
      } else {
        outcome = await deps.runtimes.tuiAgents.sendInput({
          conversationId: found.data.conversationId,
          data: `${action.input}\r`,
        });
      }
    } else if (action.kind === 'archive_worker') {
      outcome = await archiveExecution(action.execution_id);
    } else if (action.kind === 'restart_worker') {
      outcome = await restartExecution(action.execution_id, action.goal);
    } else {
      outcome = orchestrationFailure(new Error(`Unsupported always-on Orc action: ${action.kind}`));
    }
    if (outcome.success) {
      if (action.kind === 'archive_worker') {
        const archived = await fetch(
          `http://127.0.0.1:8790/workers/${encodeURIComponent(action.execution_id)}/archived`,
          {
            method: 'POST',
            headers: orcCallbackHeaders(),
            body: JSON.stringify({ success: true }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!archived.ok) {
          throw new Error(`Orc archive callback failed with HTTP ${archived.status}`);
        }
      }
      const completed = await fetch(
        `http://127.0.0.1:8790/actions/${encodeURIComponent(action.action_id)}/complete`,
        { method: 'POST', signal: AbortSignal.timeout(10_000) }
      );
      if (!completed.ok) {
        throw new Error(`Orc action completion failed with HTTP ${completed.status}`);
      }
      return;
    }
    await fetch(`http://127.0.0.1:8790/actions/${encodeURIComponent(action.action_id)}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface: 'emdash',
        stage: 'Always-on workspace action',
        status: 'failed',
        detail:
          'message' in outcome.error
            ? outcome.error.message
            : `Worker conversation not found: ${outcome.error.conversationId}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  };

  if (deps.enableOrcActionConsumer) {
    let actionQueue = Promise.resolve();
    const consume = () => {
      actionQueue = actionQueue.then(consumeOrcAction).catch(() => {});
    };
    consume();
    const timer = setInterval(consume, 1_000);
    timer.unref();
    deps.orcActionSignal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  }

  const publishOrcTransitions = async () => {
    for (const [conversationId, execution] of [...orcExecutions]) {
      const found = await findManualRun(execution.executionId);
      const replacement = found.success ? found.data?.conversationId : undefined;
      if (!replacement || replacement === conversationId) continue;
      const rebound = await fetch(
        `http://127.0.0.1:8790/workers/${encodeURIComponent(execution.executionId)}/incarnation`,
        {
          method: 'POST',
          headers: orcCallbackHeaders(),
          body: JSON.stringify({ session_id: replacement }),
          signal: AbortSignal.timeout(10_000),
        }
      ).catch(() => null);
      if (!rebound?.ok) continue;
      orcExecutions.delete(conversationId);
      orcExecutions.set(replacement, execution);
      watchInteractiveTerminalPrompts(replacement, execution);
    }
    for (const [executionId, projectId] of pendingOrcExecutions) {
      const found = await findManualRun(executionId);
      if (!found.success || !found.data?.conversationId) continue;
      const execution = { executionId, projectId };
      orcExecutions.set(found.data.conversationId, execution);
      watchInteractiveTerminalPrompts(found.data.conversationId, execution);
      pendingOrcExecutions.delete(executionId);
    }
    const states = await deps.runtimes.tuiAgents.agentStates.state(undefined, 'list').snapshot();
    for (const [conversationId, execution] of orcExecutions) {
      const state = states.data[conversationId];
      if (!state || state.status === execution.lastStatus) continue;
      const output = await deps.runtimes.tuiAgents.output.handle({ conversationId }).snapshot();
      const message = cleanWorkerText(
        state.lastAssistantMessage ?? state.message ?? output.data.text.slice(-4000)
      );
      const completedWithQuestion =
        state.status === 'completed' &&
        (message.trimEnd().endsWith('?') || /\?\s+›\s+Ask Codex/.test(message));
      const status =
        state.status === 'awaiting-input' ||
        completedWithQuestion ||
        isInteractiveTerminalPrompt(message)
          ? 'blocked'
          : state.status === 'error'
            ? 'failed'
            : state.status;
      if (status !== 'blocked') pushedPromptFingerprints.delete(execution.executionId);
      const fingerprint = crypto.createHash('sha256').update(message).digest('hex');
      if (
        status === 'blocked' &&
        pushedPromptFingerprints.get(execution.executionId) === fingerprint
      ) {
        execution.lastStatus = state.status;
        continue;
      }
      if (status === 'blocked') {
        pushedPromptFingerprints.set(execution.executionId, fingerprint);
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:8790/workers/${encodeURIComponent(execution.executionId)}/telemetry`,
          {
            method: 'POST',
            headers: orcCallbackHeaders(),
            body: JSON.stringify({
              schema_version: 1,
              event_id: orcWorkerEventId({
                executionId: execution.executionId,
                conversationId,
                status,
                sourceSequence: state.updatedAt,
                message,
              }),
              source_sequence: state.updatedAt,
              incarnation_id: conversationId,
              emdash_task_id: execution.executionId,
              execution_id: execution.executionId,
              project_id: execution.projectId,
              conversation_id: conversationId,
              provider: state.providerId,
              status,
              notification_type: state.notificationType,
              prompt_excerpt: message,
              observed_at: new Date().toISOString(),
            }),
          }
        );
        if (response.ok) execution.lastStatus = state.status;
        else if (status === 'blocked') pushedPromptFingerprints.delete(execution.executionId);
      } catch {
        // A focused reconciliation retries this retained terminal transition.
        if (status === 'blocked') pushedPromptFingerprints.delete(execution.executionId);
      }
    }
  };

  if (deps.enableOrcCallbacks) {
    let transitionQueue = Promise.resolve();
    const agentStateSource = deps.runtimes.tuiAgents.agentStates
      .state(undefined, 'list')
      .asLiveSource();
    void agentStateSource.subscribe(() => {
      transitionQueue = transitionQueue.then(publishOrcTransitions).catch(() => {});
    });
    transitionQueue = transitionQueue
      .then(async () => {
        for (const recovered of await loadOrcExecutions()) {
          const execution = {
            executionId: recovered.executionId,
            projectId: recovered.projectId,
          };
          orcExecutions.set(recovered.conversationId, execution);
          watchInteractiveTerminalPrompts(recovered.conversationId, execution);
        }
        await publishOrcTransitions();
      })
      .catch(() => {});
    const reconciliationTimer = setInterval(() => {
      transitionQueue = transitionQueue.then(publishOrcTransitions).catch(() => {});
    }, 30_000);
    reconciliationTimer.unref();
  }

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
              trustWorkspace: true,
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
        if (!started.success) return orchestrationFailure(started.error);
        if (started.data.run.conversationId) {
          const execution = {
            executionId: input.executionId,
            projectId: input.repositoryPath,
          };
          orcExecutions.set(started.data.run.conversationId, execution);
          watchInteractiveTerminalPrompts(started.data.run.conversationId, execution);
        } else {
          pendingOrcExecutions.set(input.executionId, input.repositoryPath);
        }
        return ok(started.data.run);
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
      archive: async ({ executionId }) => archiveExecution(executionId),
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
