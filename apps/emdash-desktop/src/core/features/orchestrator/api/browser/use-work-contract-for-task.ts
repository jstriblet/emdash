import { useEffect, useState } from 'react';
import type { OrchestratorWorkContract } from '../index';
import { getOrchestratorClient } from './client';

const REFRESH_INTERVAL_MS = 5_000;

export function useWorkContractForTask(taskId: string): OrchestratorWorkContract | undefined {
  const [contract, setContract] = useState<OrchestratorWorkContract>();

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await (await getOrchestratorClient()).workContracts(undefined);
        if (disposed) return;
        setContract(
          result.workContracts.find((candidate) =>
            candidate.executions.some((execution) => execution.emdash_task_id === taskId)
          )
        );
      } catch {
        if (!disposed) setContract(undefined);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  return contract;
}
