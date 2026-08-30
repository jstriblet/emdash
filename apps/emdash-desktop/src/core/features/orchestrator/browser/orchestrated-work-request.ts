import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';
import { getOrchestratorClient } from '../api/browser/client';

export type OrchestratedWorkRequest = {
  projectName: string;
  hostName: string;
  goal: string;
  agent: 'codex' | 'claude';
};

const REQUEST_PATTERN =
  /^create (?:a )?work session in (.+?) on (?:the )?(.+?) to (.+?)(?:\.\s+use (codex|claude)(?:\s+and\s+.*)?)?\.?$/i;

export function parseOrchestratedWorkRequest(text: string): OrchestratedWorkRequest | undefined {
  const match = REQUEST_PATTERN.exec(text.trim());
  if (!match) return undefined;
  return {
    projectName: match[1].trim(),
    hostName: match[2].trim(),
    goal: match[3].trim(),
    agent: match[4]?.toLowerCase() === 'claude' ? 'claude' : 'codex',
  };
}

export async function createOrchestratedWorkSession(
  request: OrchestratedWorkRequest,
  navigate: NavigateFnTyped
): Promise<void> {
  const project = [...getProjectManagerStore().projects.values()].find(
    (candidate) => candidate.name?.toLowerCase() === request.projectName.toLowerCase()
  );
  if (!project?.data) throw new Error(`Project “${request.projectName}” is not available`);
  const taskManager = getTaskManagerStore(project.id);
  if (!taskManager) throw new Error(`Project “${request.projectName}” is still loading`);
  const defaultBranch = getGitRepositoryStore(project.id)?.defaultBranchRef;
  if (!defaultBranch) throw new Error(`Project “${request.projectName}” has no default Git branch`);

  const taskId = crypto.randomUUID();
  const client = await getOrchestratorClient();
  const contract = await client.createWorkContract({
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
  });
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

  await taskManager.createTask({
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
  });

  await client.bindWorkContractExecution({
    contractId: contract.task_id,
    execution: {
      execution_id: crypto.randomUUID(),
      host_id: project.data.type === 'ssh' ? project.data.connectionId : 'local',
      project_id: project.id,
      emdash_task_id: taskId,
      agent: request.agent,
      state: 'running',
    },
  });
  navigate(taskViewDef({ projectId: project.id, taskId }));
}
