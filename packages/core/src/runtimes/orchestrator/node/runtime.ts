import {
  orchestratorHealthSchema,
  orchestratorReplySchema,
  orchestratorThreadSchema,
  type OrchestratorHealth,
  type OrchestratorReply,
  type OrchestratorThread,
} from '#runtimes/orchestrator/api';

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
      throw new Error(`Orc request failed (${response.status} ${response.statusText})`);
    }
    return parse(await response.json());
  }
}
