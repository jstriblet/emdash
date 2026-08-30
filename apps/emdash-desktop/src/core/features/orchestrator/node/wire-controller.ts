import {
  orchestratorContract,
  type OrchestratorActionResolution,
  type OrchestratorActionProgressInput,
  type OrchestratorHealth,
  type OrchestratorExecutionLinkInput,
  type OrchestratorForkUpdate,
  type OrchestratorReply,
  type OrchestratorThread,
  type OrchestratorWorkContract,
  type OrchestratorWorkContractInput,
  type OrchestratorWorkContractUpdateInput,
  type OrchestratorPendingAction,
  type OrchestratorWorkerTelemetryInput,
} from '@emdash/core/runtimes/orchestrator/api';
import { createController, type Controller } from '@emdash/wire/rpc';

export type OrchestratorRuntimePort = {
  connect(connectionId: string): Promise<OrchestratorHealth>;
  updateFork(): Promise<OrchestratorForkUpdate>;
  installMacApp(): Promise<OrchestratorForkUpdate>;
  health(): Promise<OrchestratorHealth>;
  thread(limit?: number): Promise<OrchestratorThread>;
  send(text: string): Promise<OrchestratorReply>;
  interrupt(): Promise<{ interrupted: number }>;
  resolveAction(text: string): Promise<OrchestratorActionResolution>;
  pendingActions(): Promise<{ actions: OrchestratorPendingAction[] }>;
  claimAction(): Promise<{ action: OrchestratorPendingAction | null }>;
  completeAction(actionId: string): Promise<{ completed: boolean }>;
  reportWorkerTelemetry(input: OrchestratorWorkerTelemetryInput): Promise<{ recorded: boolean }>;
  reportActionProgress(input: OrchestratorActionProgressInput): Promise<{ recorded: boolean }>;
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
    interrupt: () => runtime.interrupt(),
    resolveAction: ({ text }) => runtime.resolveAction(text),
    pendingActions: () => runtime.pendingActions(),
    claimAction: () => runtime.claimAction(),
    completeAction: ({ actionId }) => runtime.completeAction(actionId),
    reportWorkerTelemetry: (input) => runtime.reportWorkerTelemetry(input),
    reportActionProgress: (input) => runtime.reportActionProgress(input),
    workContracts: () => runtime.workContracts(),
    createWorkContract: (contract) => runtime.createWorkContract(contract),
    updateWorkContract: ({ contractId, update }) => runtime.updateWorkContract(contractId, update),
    bindWorkContractExecution: ({ contractId, execution }) =>
      runtime.bindWorkContractExecution(contractId, execution),
  });
}
