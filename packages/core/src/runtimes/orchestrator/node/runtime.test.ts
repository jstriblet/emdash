import { describe, expect, it, vi } from 'vitest';
import { OrchestratorRuntime } from './runtime';

describe('OrchestratorRuntime', () => {
  const workContract = {
    task_id: 'contract-1',
    revision: 1,
    state: 'planned',
    created_at: '2026-08-29T10:00:00-04:00',
    contract: {
      version: '1',
      goal: 'Ship the requested behavior',
      non_goals: [],
      constraints: [],
      deliverables: [{ id: 'D1', description: 'Working implementation' }],
      acceptance_checks: [
        {
          id: 'A1',
          description: 'Verify the result',
          procedure: 'Exercise it in Emdash',
          expected: 'The requested result is visible',
          required: true,
        },
      ],
      definition_of_done: 'A1 passes with evidence',
      escalation_conditions: [],
    },
    checks: [
      {
        check_id: 'A1',
        status: 'pending',
        evidence: [],
        waiver_authorized_by: null,
        waiver_reason: null,
      },
    ],
    executions: [],
  } as const;

  it('reads and validates the shared thread', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        turns: [
          {
            id: 1,
            ts: '2026-08-28T10:00:00-04:00',
            surface: 'imessage',
            role: 'user',
            content: 'hello',
          },
        ],
      })
    );
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test/', fetch });

    await expect(runtime.thread(25)).resolves.toMatchObject({ turns: [{ content: 'hello' }] });
    expect(fetch).toHaveBeenCalledWith('http://orc.test/thread?limit=25', expect.any(Object));
  });

  it('marks outbound messages as coming from Emdash', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ entry_id: 2, reply: 'hi' }));
    const runtime = new OrchestratorRuntime({ fetch });

    await runtime.send('hello');

    const init = fetch.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ surface: 'emdash', text: 'hello' });
  });

  it('resolves typed work-session actions without entering the chat loop', async () => {
    const action = {
      kind: 'create_work_session',
      action_id: 'action-1',
      project_name: 'BookScape',
      host_name: 'ThinkCenter',
      goal: 'add a README note',
      agent: 'codex',
      acceptance_checks: [{ id: 'A1', description: 'Verify the requested result', required: true }],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ action }));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });

    await expect(runtime.resolveAction('create work')).resolves.toEqual({ action });
    expect(fetch).toHaveBeenCalledWith(
      'http://orc.test/actions/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ surface: 'emdash', text: 'create work' }),
      })
    );
  });

  it('claims typed input actions for blocked workers', async () => {
    const action = {
      kind: 'send_worker_input',
      action_id: 'action-2',
      execution_id: 'execution-1',
      conversation_id: 'conversation-1',
      input: '1\n',
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ action }));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });

    await expect(runtime.claimAction()).resolves.toEqual({ action });
  });

  it('reports Emdash action progress to Orc', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ recorded: true }));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });

    await expect(
      runtime.reportActionProgress({
        actionId: 'action-1',
        stage: 'Connecting to the project host',
        status: 'failed',
        detail: 'SSH resolution failed',
      })
    ).resolves.toEqual({ recorded: true });
    expect(fetch).toHaveBeenCalledWith(
      'http://orc.test/actions/action-1/progress',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          surface: 'emdash',
          stage: 'Connecting to the project host',
          status: 'failed',
          detail: 'SSH resolution failed',
        }),
      })
    );
  });

  it('lists work contracts from the Orc response envelope', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ work_contracts: [workContract] }));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });

    await expect(runtime.workContracts()).resolves.toMatchObject({
      workContracts: [{ task_id: 'contract-1', contract: { goal: 'Ship the requested behavior' } }],
    });
    expect(fetch).toHaveBeenCalledWith('http://orc.test/work-contracts', expect.any(Object));
  });

  it('creates a work contract without treating it as an Emdash execution task', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(workContract));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });

    await runtime.createWorkContract(workContract.contract);

    expect(fetch).toHaveBeenCalledWith(
      'http://orc.test/work-contracts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(workContract.contract) })
    );
  });

  it('posts structured progress updates to a work contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(workContract));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });
    const update = {
      version: '1' as const,
      event_id: 'event-1',
      contract_revision: 1,
      sender: 'emdash-user',
      message_type: 'progress' as const,
      state: 'working' as const,
      summary: 'Started execution',
    };

    await runtime.updateWorkContract('contract/1', update);

    expect(fetch).toHaveBeenCalledWith(
      'http://orc.test/work-contracts/contract%2F1/updates',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(update) })
    );
  });

  it('links a work contract to its Emdash execution task', async () => {
    const linked = {
      ...workContract,
      executions: [
        {
          execution_id: 'exec-1',
          host_id: 'thinkcenter',
          project_id: 'bookscape',
          emdash_task_id: 'emdash-task-1',
          agent: 'codex',
          state: 'running',
          created_at: '2026-08-29T10:01:00-04:00',
          updated_at: '2026-08-29T10:01:00-04:00',
        },
      ],
    } as const;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(linked));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://orc.test', fetch });
    const execution = {
      execution_id: 'exec-1',
      host_id: 'thinkcenter',
      project_id: 'bookscape',
      emdash_task_id: 'emdash-task-1',
      agent: 'codex',
      state: 'running' as const,
    };

    await expect(runtime.bindWorkContractExecution('contract-1', execution)).resolves.toMatchObject(
      {
        executions: [{ emdash_task_id: 'emdash-task-1' }],
      }
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://orc.test/work-contracts/contract-1/executions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(execution) })
    );
  });

  it('reports the configured endpoint when the core is unreachable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const runtime = new OrchestratorRuntime({ baseUrl: 'http://thinkcenter:8790', fetch });

    await expect(runtime.health()).rejects.toThrow(
      'Unable to reach Orc at http://thinkcenter:8790'
    );
  });

  it('includes Orc validation detail when a contract transition is rejected', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { detail: 'completion blocked by required checks: A1' },
          { status: 409, statusText: 'Conflict' }
        )
      );
    const runtime = new OrchestratorRuntime({ fetch });

    await expect(runtime.workContracts()).rejects.toThrow(
      'Orc request failed (409 Conflict): completion blocked by required checks: A1'
    );
  });
});
