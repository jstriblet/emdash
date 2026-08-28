import {
  orchestratorContract,
  type OrchestratorHealth,
  type OrchestratorReply,
  type OrchestratorThread,
} from '@emdash/core/runtimes/orchestrator/api';
import { createController, type Controller } from '@emdash/wire/rpc';

export type OrchestratorRuntimePort = {
  health(): Promise<OrchestratorHealth>;
  thread(limit?: number): Promise<OrchestratorThread>;
  send(text: string): Promise<OrchestratorReply>;
};

export function createOrchestratorWireController(runtime: OrchestratorRuntimePort): Controller {
  return createController(orchestratorContract, {
    health: () => runtime.health(),
    thread: ({ limit }) => runtime.thread(limit),
    send: ({ text }) => runtime.send(text),
  });
}
