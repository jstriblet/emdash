import { when } from 'mobx';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';
import type { SshConfigHost } from '@core/primitives/ssh/api';
import { getOrchestratorClient } from '../api/browser/client';

export type OrchestratedWorkRequest = {
  projectName: string;
  hostName: string;
  goal: string;
  agent: 'codex' | 'claude';
};

export type OrchestratedWorkStage =
  | 'Connecting to the project host'
  | 'Locating the repository'
  | 'Registering the project'
  | 'Loading the project'
  | 'Creating the work contract'
  | 'Launching the agent'
  | 'Recording the execution';

type ProgressReporter = (
  stage: OrchestratedWorkStage,
  status: 'started' | 'completed' | 'failed',
  detail?: string
) => void | Promise<void>;

const STAGE_TIMEOUT_MS = 45_000;
const HOST_READY_RETRY_MS = 500;
const HOST_READY_TIMEOUT_MS = 40_000;

type OrchestratedProjectType = { type: 'local' } | { type: 'ssh'; connectionId: string };

const REQUEST_PATTERN =
  /^(?:>\s*)?create (?:a )?work session in (.+?) on (?:the )?(.+?) to (.+?)(?:\.\s+use (codex|claude)(?:\s+and\s+.*)?)?\.?$/i;
const REPOSITORY_CHANGE_PATTERN =
  /^(?:>\s*)?(?:can you\s+|please\s+)?(.+?)\s+(?:in|to)\s+(?:the\s+)?(.+?)\s+repo(?:sitory)?[?.]?$/i;

export function parseOrchestratedWorkRequest(text: string): OrchestratedWorkRequest | undefined {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const match = REQUEST_PATTERN.exec(normalized);
  if (!match) {
    const repositoryChange = REPOSITORY_CHANGE_PATTERN.exec(normalized);
    if (!repositoryChange) return undefined;
    return {
      projectName: repositoryChange[2].trim(),
      hostName: 'Auto',
      goal: repositoryChange[1].trim(),
      agent: 'codex',
    };
  }
  return {
    projectName: match[1].trim(),
    hostName: match[2].trim(),
    goal: match[3].trim(),
    agent: match[4]?.toLowerCase() === 'claude' ? 'claude' : 'codex',
  };
}

export async function createOrchestratedWorkSession(
  request: OrchestratedWorkRequest,
  navigate: NavigateFnTyped,
  onProgress: ProgressReporter = () => {}
): Promise<void> {
  const projectManager = getProjectManagerStore();
  const projectType = await runStage(
    'Connecting to the project host',
    resolveProjectHost(request.hostName),
    onProgress
  );
  let project = [...projectManager.projects.values()].find(
    (candidate) =>
      candidate.name?.toLowerCase() === request.projectName.toLowerCase() &&
      candidate.data &&
      projectMatchesHost(candidate.data, projectType)
  );

  if (!project?.data) {
    const path = await runStage(
      'Locating the repository',
      discoverProjectPath(projectType, request.projectName),
      onProgress
    );
    if (!path) {
      throw new Error(
        `Orc could not find a Git repository named “${request.projectName}” on ${request.hostName}`
      );
    }
    const projectId = await runStage(
      'Registering the project',
      projectManager.createProject(projectType, {
        mode: 'pick',
        name: request.projectName,
        path,
        initGitRepository: false,
      }),
      onProgress
    );
    if (!projectId) {
      throw new Error(`Orc found ${path}, but Emdash could not register the project`);
    }
    await runStage(
      'Loading the project',
      projectManager.hydrateProjectContext(projectId),
      onProgress
    );
    project = projectManager.projects.get(projectId);
  }

  if (!project?.data) throw new Error(`Project “${request.projectName}” failed to load`);
  const taskManager = getTaskManagerStore(project.id);
  if (!taskManager) throw new Error(`Project “${request.projectName}” is still loading`);
  const defaultBranch = getGitRepositoryStore(project.id)?.defaultBranchRef;
  if (!defaultBranch) throw new Error(`Project “${request.projectName}” has no default Git branch`);

  const taskId = crypto.randomUUID();
  const client = await getOrchestratorClient();
  const contract = await runStage(
    'Creating the work contract',
    client.createWorkContract({
      version: '1',
      goal: request.goal,
      non_goals: [],
      constraints: [`Run on ${request.hostName}`, `Use ${request.agent}`],
      deliverables: [{ id: 'D1', description: request.goal }],
      acceptance_checks: [
        {
          id: 'A1',
          description: 'Verify the requested result',
          procedure: 'Run the project test suite and inspect the resulting diff',
          expected: 'Tests pass and the implementation satisfies the requested outcome',
          required: true,
        },
      ],
      definition_of_done: 'D1 is implemented and A1 passes with recorded evidence',
      escalation_conditions: [
        'Requirements are ambiguous',
        'Required access or credentials are missing',
      ],
    }),
    onProgress
  );
  const branchStem = request.goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  const branchName = `orc/${branchStem || 'work'}-${taskId.slice(0, 8)}`;
  const initialPrompt = [
    `Work Contract ${contract.task_id}`,
    `Goal: ${request.goal}`,
    'Implement the goal in this worktree.',
    'Run the relevant tests and preserve concrete evidence of the result.',
    'Do not claim completion until the acceptance check is satisfied.',
  ].join('\n\n');

  await runStage(
    'Launching the agent',
    taskManager.createTask({
      id: taskId,
      projectId: project.id,
      taskConfig: {
        version: '1',
        name: request.goal,
        initialConversation: {
          id: crypto.randomUUID(),
          provider: request.agent,
          title: request.goal,
          autoApprove: true,
          initialPrompt,
          type: 'pty',
        },
      },
      workspaceConfig: {
        version: '2',
        git: {
          kind: 'create-branch',
          branchName,
          fromBranch: defaultBranch,
          pushBranch: false,
        },
        workspace: { kind: 'new-worktree' },
      },
    }),
    onProgress,
    120_000
  );

  await runStage(
    'Recording the execution',
    client.bindWorkContractExecution({
      contractId: contract.task_id,
      execution: {
        execution_id: crypto.randomUUID(),
        host_id: project.data.type === 'ssh' ? project.data.connectionId : 'local',
        project_id: project.id,
        emdash_task_id: taskId,
        agent: request.agent,
        state: 'running',
      },
    }),
    onProgress
  );
  navigate(taskViewDef({ projectId: project.id, taskId }));
}

export async function runStage<T>(
  stage: OrchestratedWorkStage,
  operation: Promise<T>,
  onProgress: ProgressReporter = () => {},
  timeoutMs = STAGE_TIMEOUT_MS
): Promise<T> {
  const report = async (status: 'started' | 'completed' | 'failed', detail?: string) => {
    await Promise.resolve(onProgress(stage, status, detail)).catch(() => {});
  };
  await report('started');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${stage} timed out after ${Math.round(timeoutMs / 1_000)} seconds`));
        }, timeoutMs);
      }),
    ]);
    await report('completed');
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unknown error';
    await report('failed', message);
    if (message.startsWith(stage)) throw cause;
    throw new Error(`${stage} failed: ${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveProjectHost(hostName: string): Promise<OrchestratedProjectType> {
  if (/^(?:local|this mac|my mac|mac)$/i.test(hostName.trim())) return { type: 'local' };

  const machines = getMachinesStore();
  await machines.start();
  if (/^auto$/i.test(hostName.trim())) {
    const [onlyMachine] = machines.connections;
    if (machines.connections.length === 0) return { type: 'local' };
    if (machines.connections.length === 1 && onlyMachine) {
      return await resolveProjectHost(onlyMachine.name);
    }
    throw new Error('Orc found multiple machines; name the machine that contains the repository');
  }
  const normalized = hostName.trim().toLowerCase();
  let connection = findExistingMachine(machines.connections, normalized);
  let configuredHost: SshConfigHost | undefined;
  if (!connection) {
    const configuredHosts = await machines.getSshConfigHosts();
    configuredHost =
      findSshConfigHost(configuredHosts, hostName) ??
      (await machines.getSshConfigHost(hostName.trim()).catch(() => undefined));
    const resolvedHostname = configuredHost?.hostname?.trim().toLowerCase();
    if (resolvedHostname) {
      connection = findExistingMachine(machines.connections, normalized, resolvedHostname);
    }
  }
  if (connection) {
    const connectionId = connection.id;
    await machines.connect(connectionId);
    await waitForMachineConnection(machines, connectionId);
    if (machines.stateFor(connectionId) !== 'connected') {
      throw new Error(`SSH connection to “${hostName}” failed`);
    }
    return { type: 'ssh', connectionId };
  }

  const sshConfigHost =
    configuredHost ?? (await machines.getSshConfigHost(hostName.trim()).catch(() => undefined));
  if (!sshConfigHost) {
    throw new Error(`Orc could not find “${hostName}” in Emdash Machines or this Mac’s SSH config`);
  }
  const saved = await machines.saveConnection(sshConfigHostToConnection(sshConfigHost));
  await machines.connect(saved.id);
  await waitForMachineConnection(machines, saved.id);
  if (machines.stateFor(saved.id) !== 'connected') {
    throw new Error(`SSH connection to “${hostName}” failed`);
  }
  return { type: 'ssh', connectionId: saved.id };
}

export function findExistingMachine<T extends { name: string; host: string }>(
  connections: T[],
  requestedHost: string,
  resolvedHostname?: string
): T | undefined {
  const requested = requestedHost.trim().toLowerCase();
  const resolved = resolvedHostname?.trim().toLowerCase();
  return connections.find((candidate) => {
    const name = candidate.name.trim().toLowerCase();
    const host = candidate.host.trim().toLowerCase();
    return (
      name === requested || host === requested || (resolved !== undefined && host === resolved)
    );
  });
}

async function waitForMachineConnection(
  machines: Pick<ReturnType<typeof getMachinesStore>, 'stateFor'>,
  connectionId: string
): Promise<void> {
  if (machines.stateFor(connectionId) === 'error') {
    await when(() => machines.stateFor(connectionId) !== 'error', {
      timeout: HOST_READY_TIMEOUT_MS,
    });
  }
  await when(() => ['connected', 'error'].includes(machines.stateFor(connectionId)), {
    timeout: HOST_READY_TIMEOUT_MS,
  });
}

export function findSshConfigHost(
  hosts: SshConfigHost[],
  requestedName: string
): SshConfigHost | undefined {
  const requested = normalizeHostName(requestedName);
  const concreteHosts = hosts.filter((host) => !/[*!?]/.test(host.host));
  return concreteHosts.find(
    (host) =>
      normalizeHostName(host.host) === requested ||
      normalizeHostName(host.hostname ?? '') === requested
  );
}

export function sshConfigHostToConnection(host: SshConfigHost) {
  return {
    name: host.host,
    host: host.hostname || host.host,
    port: host.port ?? 22,
    username: host.user || host.host,
    sshConfigAlias: host.host,
    authType: host.identityAgent
      ? ('agent' as const)
      : host.identityFile
        ? ('key' as const)
        : ('agent' as const),
    useAgent: Boolean(host.identityAgent || !host.identityFile),
  };
}

function normalizeHostName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function discoverProjectPath(
  projectType: OrchestratedProjectType,
  projectName: string
): Promise<string | undefined> {
  const client = await getProjectsWireClient();
  const host =
    projectType.type === 'ssh'
      ? { type: 'ssh' as const, connectionId: projectType.connectionId }
      : { type: 'local' as const };
  const home = await withHostReadinessRetry(() => client.getHostHomeDir(host));

  for (const path of projectPathCandidates(home, projectName)) {
    const inspection = await withHostReadinessRetry(() =>
      client.inspectProjectPath(
        projectType.type === 'ssh'
          ? { type: 'ssh', connectionId: projectType.connectionId, path }
          : { type: 'local', path }
      )
    );
    if (!inspection.error && inspection.isDirectory && inspection.isGitRepo) return path;
  }
  return undefined;
}

export async function withHostReadinessRetry<T>(
  operation: () => Promise<T>,
  timeoutMs = HOST_READY_TIMEOUT_MS,
  retryMs = HOST_READY_RETRY_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await operation();
    } catch (cause) {
      if (!isHostPreparingError(cause) || Date.now() + retryMs > deadline) throw cause;
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function isHostPreparingError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /host (?:connection|runtime) (?:failed|is not ready|is unavailable)/i.test(cause.message);
}

export function projectPathCandidates(home: string, projectName: string): string[] {
  const names = [projectName.trim(), projectName.trim().toLowerCase()];
  const roots = [
    'src',
    'Projects',
    'projects',
    'Developer',
    'Code',
    'code',
    'repos',
    'Repositories',
  ];
  return [...new Set(roots.flatMap((root) => names.map((name) => joinHostPath(home, root, name))))];
}

function joinHostPath(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .join('/');
}

function projectMatchesHost(
  project: { type: 'local' } | { type: 'ssh'; connectionId: string },
  projectType: OrchestratedProjectType
): boolean {
  return (
    project.type === projectType.type &&
    (project.type === 'local' ||
      (projectType.type === 'ssh' && project.connectionId === projectType.connectionId))
  );
}
