import { hostRef } from '@emdash/core/primitives/host/api';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTasksWireClient } from '@core/features/tasks/api/browser/client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getWorkspaceRegistryWireClient } from '@core/features/workspaces/api/browser/client';
import { log } from '@core/primitives/logging/browser/logger';
import type { OrchestratorWorkContract } from '../api';
import { getOrchestratorClient } from '../api/browser/client';

const projectionAttempts = new Set<string>();
const projectCreationAttempts = new Set<string>();
const linkedConversations = new Set<string>();
const openedConversations = new Set<string>();
const reportedProjectionStages = new Set<string>();
const REFRESH_INTERVAL_MS = 2_000;
const CONVERSATION_ADOPTION_ATTEMPTS = 40;
const CONVERSATION_ADOPTION_RETRY_MS = 250;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function reportProjectionStage(
  executionId: string,
  stage: string,
  status: 'started' | 'completed' | 'failed',
  detail: string
): Promise<void> {
  const key = `${executionId}:${stage}:${status}:${detail}`;
  if (reportedProjectionStages.has(key)) return;
  reportedProjectionStages.add(key);
  try {
    await (
      await getOrchestratorClient()
    ).reportActionProgress({ actionId: executionId, stage, status, detail });
  } catch {
    reportedProjectionStages.delete(key);
  }
}

function normalizedHost(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

async function findOrCreateProject(repositoryPath: string, hostId: string) {
  const projects = getProjectManagerStore();
  const existing = [...projects.projects.values()].find(
    (candidate) => candidate.data?.type === 'ssh' && candidate.data.path === repositoryPath
  );
  if (existing) return existing;

  const creationKey = `${hostId}:${repositoryPath}`;
  if (projectCreationAttempts.has(creationKey)) return undefined;

  const machines = await (await getMachinesClient()).getMachines(undefined);
  const wanted = normalizedHost(hostId);
  const machine = machines.find((candidate) =>
    [candidate.name, candidate.host, candidate.sshConfigAlias]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalizedHost(value) === wanted)
  );
  if (!machine) return undefined;

  projectCreationAttempts.add(creationKey);
  const projectId = await projects.createProject(
    { type: 'ssh', connectionId: machine.id },
    { mode: 'pick', name: basename(repositoryPath), path: repositoryPath }
  );
  if (!projectId) {
    projectCreationAttempts.delete(creationKey);
    return undefined;
  }
  return projects.projects.get(projectId);
}

function taskStatus(contract: OrchestratorWorkContract) {
  if (contract.state === 'completed') return 'done' as const;
  if (contract.state === 'failed') return 'cancelled' as const;
  if (contract.state === 'planned') return 'todo' as const;
  if (contract.state === 'verifying' || contract.state === 'handoff') return 'review' as const;
  return 'in_progress' as const;
}

function taskName(contract: OrchestratorWorkContract): string {
  const goal = contract.contract.goal.trim();
  return goal.length <= 80 ? goal : `${goal.slice(0, 77)}...`;
}

function isTerminal(contract: OrchestratorWorkContract): boolean {
  const execution = contract.executions.at(-1);
  return (
    contract.state === 'completed' ||
    contract.state === 'failed' ||
    execution?.state === 'completed' ||
    execution?.state === 'failed'
  );
}

async function closeTerminalProjection(contract: OrchestratorWorkContract): Promise<void> {
  const execution = contract.executions.at(-1);
  if (!execution || !isTerminal(contract)) return;
  const projects = getProjectManagerStore();
  const project = [...projects.projects.values()].find(
    (candidate) => candidate.data?.type === 'ssh' && candidate.data.path === execution.project_id
  );
  if (!project) return;
  const taskManager = getTaskManagerStore(project.id);
  const task = taskManager?.tasks.get(contract.task_id);
  if (!task || !taskManager) return;
  if (task.state === 'unregistered') {
    runInAction(() => taskManager.tasks.delete(contract.task_id));
    return;
  }
  await taskManager.deleteTask(contract.task_id, {
    deleteWorktree: false,
    deleteBranch: false,
  });
}

/**
 * Projects a host-owned Orc execution into the desktop's normal Project → Task model.
 * The task merely adopts the already-created host workspace and conversation; it never
 * provisions a second worktree or starts another agent on the desktop.
 */
export async function projectOrcWorkersIntoTasks(
  contracts: readonly OrchestratorWorkContract[]
): Promise<void> {
  const projects = getProjectManagerStore();
  await projects.load();

  for (const contract of contracts) {
    const execution = contract.executions.at(-1);
    await closeTerminalProjection(contract);
    // Completed workers have already been verified and archived on the host. Their
    // workspace records may no longer exist, so replaying them into a fresh desktop
    // would create a task that can never resolve its selected workspace.
    if (!execution?.worktree_path || isTerminal(contract)) {
      continue;
    }

    const project = await findOrCreateProject(execution.project_id, execution.host_id);
    if (!project?.data || project.data.type !== 'ssh' || projectionAttempts.has(contract.task_id)) {
      continue;
    }
    const connectionId = project.data.connectionId;

    const taskManager = getTaskManagerStore(project.id);
    if (!taskManager) continue;

    projectionAttempts.add(contract.task_id);
    try {
      let task = taskManager.tasks.get(contract.task_id);
      if (!task) {
        const workspace = await (
          await getWorkspaceRegistryWireClient()
        ).createWorkspace({
          host: hostRef('remote', connectionId),
          path: execution.worktree_path,
        });
        if (!workspace.success) {
          await reportProjectionStage(
            execution.execution_id,
            'Desktop workspace claim',
            'failed',
            JSON.stringify(workspace.error)
          );
          log.debug('Orc workspace could not be claimed by the desktop', {
            taskId: contract.task_id,
            workspacePath: execution.worktree_path,
            error: workspace.error,
          });
          continue;
        }
        await reportProjectionStage(
          execution.execution_id,
          'Desktop workspace claim',
          'completed',
          workspace.data.id
        );

        const created = await (
          await getTasksWireClient()
        ).createTask({
          id: contract.task_id,
          projectId: project.id,
          taskConfig: {
            version: '1',
            name: taskName(contract),
            initialStatus: taskStatus(contract),
          },
          workspaceConfig: {
            version: '2',
            git: { kind: 'none' },
            workspace: {
              kind: 'repository-instance',
              workspaceId: workspace.data.id,
            },
          },
        });
        if (!created.success) {
          await reportProjectionStage(
            execution.execution_id,
            'Desktop task projection',
            'failed',
            JSON.stringify(created.error)
          );
          log.debug('Orc workspace is not ready for project-rail projection', {
            taskId: contract.task_id,
            projectPath: execution.project_id,
            error: created.error,
          });
          continue;
        }
        await reportProjectionStage(
          execution.execution_id,
          'Desktop task projection',
          'completed',
          contract.task_id
        );
        task = taskManager.tasks.get(contract.task_id);
      }

      const status = taskStatus(contract);
      if (task?.data.status !== status) await task?.updateStatus(status);

      if (execution.session_id && !linkedConversations.has(execution.session_id)) {
        const conversations = await getConversationsClient();
        let adopted = false;
        for (let attempt = 0; attempt < CONVERSATION_ADOPTION_ATTEMPTS; attempt += 1) {
          adopted = await conversations.adoptHostConversation({
            host: hostRef('remote', connectionId),
            conversationId: execution.session_id,
            projectId: project.id,
            taskId: contract.task_id,
          });
          if (adopted) break;
          await delay(CONVERSATION_ADOPTION_RETRY_MS);
        }
        if (!adopted) {
          await reportProjectionStage(
            execution.execution_id,
            'Desktop conversation adoption',
            'failed',
            `Host conversation ${execution.session_id} was absent from the authoritative snapshot`
          );
          throw new Error(`Host conversation ${execution.session_id} was not found`);
        }
        await reportProjectionStage(
          execution.execution_id,
          'Desktop conversation adoption',
          'completed',
          execution.session_id
        );
        linkedConversations.add(execution.session_id);
      }
      if (execution.session_id && !openedConversations.has(execution.session_id)) {
        const conversationManager = getConversationsForTask(contract.task_id);
        let conversation = conversationManager?.conversations.get(execution.session_id);
        if (conversationManager && !conversation) {
          await conversationManager.list.load();
          conversation = conversationManager.conversations.get(execution.session_id);
        }
        const taskView = getTaskComposition(project.id, contract.task_id);
        if (conversation && taskView) {
          taskView.paneLayout.open(
            'conversation',
            { conversationId: execution.session_id },
            { preview: false }
          );
          taskView.setFocusedRegion('main');
          openedConversations.add(execution.session_id);
          await reportProjectionStage(
            execution.execution_id,
            'Desktop conversation pane',
            'completed',
            execution.session_id
          );
        } else {
          await reportProjectionStage(
            execution.execution_id,
            'Desktop conversation pane',
            'started',
            JSON.stringify({
              conversationHydrated: Boolean(conversation),
              taskCompositionMounted: Boolean(taskView),
            })
          );
        }
      }
    } catch (error) {
      await reportProjectionStage(
        execution.execution_id,
        'Desktop worker projection',
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      log.warn('Unable to project Orc worker into the project rail yet', {
        taskId: contract.task_id,
        projectPath: execution.project_id,
        error,
      });
    } finally {
      projectionAttempts.delete(contract.task_id);
    }
  }
}

/** Keeps server-owned Orc runs projected into the ordinary project rail. */
export function OrcWorkerProjection() {
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await (await getOrchestratorClient()).workContracts(undefined);
        if (!disposed) await projectOrcWorkersIntoTasks(result.workContracts);
      } catch (error) {
        if (!disposed) log.warn('Unable to refresh Orc project tasks', { error });
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
