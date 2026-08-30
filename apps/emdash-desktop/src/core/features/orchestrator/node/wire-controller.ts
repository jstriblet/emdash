import {
  orchestratorContract,
  type OrchestratorHealth,
  type OrchestratorExecutionLinkInput,
  type OrchestratorForkUpdate,
  type OrchestratorReply,
  type OrchestratorThread,
  type OrchestratorWorkContract,
  type OrchestratorWorkContractInput,
  type OrchestratorWorkContractUpdateInput,
} from '@emdash/core/runtimes/orchestrator/api';
import { createController, type Controller } from '@emdash/wire/rpc';

export type OrchestratorRuntimePort = {
  connect(connectionId: string): Promise<OrchestratorHealth>;
  updateFork(): Promise<OrchestratorForkUpdate>;
  installMacApp(): Promise<OrchestratorForkUpdate>;
  health(): Promise<OrchestratorHealth>;
  thread(limit?: number): Promise<OrchestratorThread>;
  send(text: string): Promise<OrchestratorReply>;
  workContracts(): Promise<{ workContracts: OrchestratorWorkContract[] }>;
  createWorkContract(contract: OrchestratorWorkContractInput): Promise<OrchestratorWorkContract>;
  updateWorkContract(
    contractId: string,
    update: OrchestratorWorkContractUpdateInput
  ): Promise<OrchestratorWorkContract>;
  bindWorkContractExecution(
    contractId: string,
    execution: OrchestratorExecutionLinkInput
  ): Promise<OrchestratorWorkContract>;
};

export function createOrchestratorWireController(runtime: OrchestratorRuntimePort): Controller {
  return createController(orchestratorContract, {
    connect: ({ connectionId }) => runtime.connect(connectionId),
    updateFork: () => runtime.updateFork(),
    installMacApp: () => runtime.installMacApp(),
    health: () => runtime.health(),
    thread: ({ limit }) => runtime.thread(limit),
    send: ({ text }) => runtime.send(text),
    workContracts: () => runtime.workContracts(),
    createWorkContract: (contract) => runtime.createWorkContract(contract),
    updateWorkContract: ({ contractId, update }) => runtime.updateWorkContract(contractId, update),
    bindWorkContractExecution: ({ contractId, execution }) =>
      runtime.bindWorkContractExecution(contractId, execution),
  });
}
