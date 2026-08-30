import {
  orchestratorHealthSchema,
  orchestratorReplySchema,
  orchestratorWorkContractSchema,
  orchestratorThreadSchema,
  type OrchestratorHealth,
  type OrchestratorReply,
  type OrchestratorThread,
  type OrchestratorWorkContract,
  type OrchestratorWorkContractInput,
  type OrchestratorWorkContractUpdateInput,
} from '#runtimes/orchestrator/api';
import { z } from 'zod';

type Fetch = typeof globalThis.fetch;

export type OrchestratorRuntimeOptions = {
  baseUrl?: string;
  fetch?: Fetch;
};

export class OrchestratorRuntime {
  readonly #baseUrl: string;
  readonly #fetch: Fetch;

  constructor(options: OrchestratorRuntimeOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  health(): Promise<OrchestratorHealth> {
    return this.#request('/health', undefined, orchestratorHealthSchema.parse);
  }

  thread(limit = 100): Promise<OrchestratorThread> {
    return this.#request(
      `/thread?limit=${encodeURIComponent(limit)}`,
      undefined,
      orchestratorThreadSchema.parse
    );
  }

  send(text: string): Promise<OrchestratorReply> {
    return this.#request(
      '/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: 'emdash', text }),
      },
      orchestratorReplySchema.parse
    );
  }

  workContracts(): Promise<{ workContracts: OrchestratorWorkContract[] }> {
    return this.#request('/work-contracts', undefined, (value) => {
      const record = value as { work_contracts?: unknown };
      return { workContracts: z.array(orchestratorWorkContractSchema).parse(record.work_contracts) };
    });
  }

  createWorkContract(contract: OrchestratorWorkContractInput): Promise<OrchestratorWorkContract> {
    return this.#request(
      '/work-contracts',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(contract) },
      orchestratorWorkContractSchema.parse
    );
  }

  updateWorkContract(
    contractId: string,
    update: OrchestratorWorkContractUpdateInput
  ): Promise<OrchestratorWorkContract> {
    return this.#request(
      `/work-contracts/${encodeURIComponent(contractId)}/updates`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) },
      orchestratorWorkContractSchema.parse
    );
  }

  async #request<T>(
    path: string,
    init: RequestInit | undefined,
    parse: (value: unknown) => T
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new Error(`Unable to reach Orc at ${this.#baseUrl}`, { cause: error });
    }
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body.detail === 'string') detail = body.detail;
      } catch {
        // Some proxies return an empty or non-JSON response for upstream failures.
      }
      const suffix = detail ? `: ${detail}` : '';
      throw new Error(`Orc request failed (${response.status} ${response.statusText})${suffix}`);
    }
    return parse(await response.json());
  }
}
