import { domainClient } from '@core/primitives/wire/browser/connection';
import { orchestratorContract, orchestratorDomain } from '@emdash/core/runtimes/orchestrator/api';
import type { ContractClient } from '@emdash/wire/rpc';

export type OrchestratorClient = ContractClient<typeof orchestratorContract>;

export function getOrchestratorClient(): Promise<OrchestratorClient> {
  return domainClient<OrchestratorClient>(orchestratorDomain, orchestratorContract);
}
