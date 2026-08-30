import { z } from 'zod';

export const orchestratorRoleSchema = z.enum([
  'user',
  'assistant',
  'assistant_progress',
  'activity',
  'system',
]);

export const orchestratorSurfaceSchema = z.enum(['terminal', 'imessage', 'emdash']);

export const orchestratorEntrySchema = z.object({
  id: z.number().int().positive(),
  ts: z.string(),
  surface: orchestratorSurfaceSchema,
  role: orchestratorRoleSchema,
  content: z.string(),
  turn_id: z.string().nullable().optional(),
});

export const orchestratorHealthSchema = z.object({
  status: z.literal('ok'),
  entries: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string().nullable(),
  directory: z.string().nullable().optional(),
  sandbox: z.string().nullable().optional(),
  busy: z.boolean(),
});

export const orchestratorThreadSchema = z.object({
  turns: z.array(orchestratorEntrySchema),
});

export const orchestratorReplySchema = z.object({
  entry_id: z.number().int().positive(),
  reply: z.string(),
  error: z.string().optional(),
});

export const orchestratorWorkSessionActionSchema = z.object({
  kind: z.literal('create_work_session'),
  action_id: z.string().min(1),
  project_name: z.string().min(1),
  host_name: z.string().min(1),
  goal: z.string().min(1),
  agent: z.enum(['codex', 'claude']),
  acceptance_checks: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      required: z.boolean(),
    })
  ),
});

export const orchestratorWorkerInputActionSchema = z.object({
  kind: z.literal('send_worker_input'),
  action_id: z.string().min(1),
  execution_id: z.string().min(1),
  conversation_id: z.string().min(1),
  input: z.string().min(1).max(1_000),
});

export const orchestratorWorkerRestartActionSchema = z.object({
  kind: z.literal('restart_worker'),
  action_id: z.string().min(1),
  execution_id: z.string().min(1),
  emdash_task_id: z.string().min(1),
  conversation_id: z.string().min(1),
  goal: z.string().min(1),
});

export const orchestratorWorkerArchiveActionSchema = z.object({
  kind: z.literal('archive_worker'),
  action_id: z.string().min(1),
  execution_id: z.string().min(1),
  project_id: z.string().min(1),
  emdash_task_id: z.string().min(1),
});

export const orchestratorPendingActionSchema = z.discriminatedUnion('kind', [
  orchestratorWorkSessionActionSchema,
  orchestratorWorkerInputActionSchema,
  orchestratorWorkerRestartActionSchema,
  orchestratorWorkerArchiveActionSchema,
]);

export const orchestratorActionResolutionSchema = z.object({
  action: orchestratorWorkSessionActionSchema.nullable(),
});

export const orchestratorPendingActionsSchema = z.object({
  actions: z.array(orchestratorPendingActionSchema),
});

export const orchestratorClaimedActionSchema = z.object({
  action: orchestratorPendingActionSchema.nullable(),
});

export const orchestratorActionCompletionSchema = z.object({ completed: z.boolean() });

export const orchestratorWorkerTelemetryInputSchema = z.object({
  executionId: z.string().min(1),
  emdashTaskId: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  status: z.string().min(1),
  notificationType: z.string().nullable().optional(),
  promptExcerpt: z.string().max(4_000).nullable().optional(),
  observedAt: z.string().min(1),
});
export const orchestratorWorkerTelemetryResultSchema = z.object({ recorded: z.boolean() });

export const orchestratorActionProgressInputSchema = z.object({
  actionId: z.string().min(1),
  stage: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed']),
  detail: z.string().optional(),
});

export const orchestratorActionProgressResultSchema = z.object({ recorded: z.boolean() });

export const orchestratorForkUpdateSchema = z.object({
  updated: z.boolean(),
  message: z.string(),
});

export const orchestratorEvidenceSchema = z.object({
  kind: z.enum(['command', 'test', 'diff', 'commit', 'file', 'log', 'screenshot', 'url']),
  reference: z.string().min(1),
  summary: z.string().min(1),
});

export const orchestratorWorkContractInputSchema = z.object({
  version: z.literal('1').default('1'),
  goal: z.string().min(1),
  non_goals: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.object({ id: z.string(), description: z.string() })).min(1),
  acceptance_checks: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        procedure: z.string(),
        expected: z.string(),
        required: z.boolean().default(true),
      })
    )
    .min(1),
  definition_of_done: z.string().min(1),
  escalation_conditions: z.array(z.string()).default([]),
});

export const orchestratorWorkContractCheckStateSchema = z.object({
  check_id: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'blocked', 'waived']),
  evidence: z.array(orchestratorEvidenceSchema),
  waiver_authorized_by: z.string().nullable(),
  waiver_reason: z.string().nullable(),
});

export const orchestratorExecutionLinkInputSchema = z.object({
  execution_id: z.string().min(1),
  host_id: z.string().min(1),
  project_id: z.string().min(1),
  emdash_task_id: z.string().min(1),
  agent: z.string().min(1),
  state: z.enum(['requested', 'provisioning', 'running', 'blocked', 'completed', 'failed']),
  worktree_path: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
});

export const orchestratorExecutionLinkSchema = orchestratorExecutionLinkInputSchema.extend({
  created_at: z.string(),
  updated_at: z.string(),
});

export const orchestratorWorkContractSchema = z.object({
  task_id: z.string(),
  revision: z.number().int().positive(),
  state: z.enum(['planned', 'working', 'verifying', 'blocked', 'handoff', 'completed', 'failed']),
  created_at: z.string(),
  contract: orchestratorWorkContractInputSchema,
  checks: z.array(orchestratorWorkContractCheckStateSchema),
  executions: z.array(orchestratorExecutionLinkSchema),
});

export const orchestratorWorkContractUpdateInputSchema = z.object({
  version: z.literal('1').default('1'),
  event_id: z.string().min(1),
  contract_revision: z.number().int().positive(),
  sender: z.string().min(1),
  recipient: z.string().nullable().optional(),
  message_type: z.enum([
    'plan',
    'progress',
    'evidence',
    'question',
    'decision',
    'blocker',
    'handoff',
    'verification',
    'completion',
  ]),
  state: z.enum(['planned', 'working', 'verifying', 'blocked', 'handoff', 'completed', 'failed']),
  summary: z.string().min(1),
  affected_ids: z.array(z.string()).default([]),
  evidence: z.array(orchestratorEvidenceSchema).default([]),
  blockers: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  authority_needed: z.array(z.string()).default([]),
  next_action: z.string().nullable().optional(),
  next_owner: z.string().nullable().optional(),
  check_results: z
    .array(
      z.object({
        check_id: z.string(),
        status: z.enum(['running', 'passed', 'failed', 'blocked', 'waived']),
        evidence: z.array(orchestratorEvidenceSchema).default([]),
        waiver_authorized_by: z.string().nullable().optional(),
        waiver_reason: z.string().nullable().optional(),
      })
    )
    .default([]),
});

export type OrchestratorEntry = z.infer<typeof orchestratorEntrySchema>;
export type OrchestratorHealth = z.infer<typeof orchestratorHealthSchema>;
export type OrchestratorThread = z.infer<typeof orchestratorThreadSchema>;
export type OrchestratorReply = z.infer<typeof orchestratorReplySchema>;
export type OrchestratorActionResolution = z.infer<typeof orchestratorActionResolutionSchema>;
export type OrchestratorActionProgressInput = z.infer<typeof orchestratorActionProgressInputSchema>;
export type OrchestratorWorkSessionAction = z.infer<typeof orchestratorWorkSessionActionSchema>;
export type OrchestratorWorkerInputAction = z.infer<typeof orchestratorWorkerInputActionSchema>;
export type OrchestratorPendingAction = z.infer<typeof orchestratorPendingActionSchema>;
export type OrchestratorWorkerTelemetryInput = z.infer<
  typeof orchestratorWorkerTelemetryInputSchema
>;
export type OrchestratorForkUpdate = z.infer<typeof orchestratorForkUpdateSchema>;
export type OrchestratorWorkContractInput = z.infer<typeof orchestratorWorkContractInputSchema>;
export type OrchestratorWorkContract = z.infer<typeof orchestratorWorkContractSchema>;
export type OrchestratorExecutionLinkInput = z.infer<typeof orchestratorExecutionLinkInputSchema>;
export type OrchestratorWorkContractUpdateInput = z.infer<
  typeof orchestratorWorkContractUpdateInputSchema
>;
