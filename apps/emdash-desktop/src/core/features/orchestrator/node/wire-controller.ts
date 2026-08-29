import {
  orchestratorContract,
  type OrchestratorHealth,
  type OrchestratorForkUpdate,
  type OrchestratorReply,
  type OrchestratorThread,
} from '@emdash/core/runtimes/orchestrator/api';
import { createController, type Controller } from '@emdash/wire/rpc';

export type OrchestratorRuntimePort = {
  connect(connectionId: string): Promise<OrchestratorHealth>;
  updateFork(): Promise<OrchestratorForkUpdate>;
  installMacApp(): Promise<OrchestratorForkUpdate>;
  health(): Promise<OrchestratorHealth>;
  thread(limit?: number): Promise<OrchestratorThread>;
  send(text: string): Promise<OrchestratorReply>;
};

export function createOrchestratorWireController(runtime: OrchestratorRuntimePort): Controller {
  return createController(orchestratorContract, {
    connect: ({ connectionId }) => runtime.connect(connectionId),
    updateFork: () => runtime.updateFork(),
    installMacApp: () => runtime.installMacApp(),
    health: () => runtime.health(),
    thread: ({ limit }) => runtime.thread(limit),
    send: ({ text }) => runtime.send(text),
  });
}
