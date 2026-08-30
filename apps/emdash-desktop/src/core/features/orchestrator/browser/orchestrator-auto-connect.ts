type SavedMachine = { id: string };

type AutoConnectClient = {
  health(): Promise<unknown>;
  connect(input: { connectionId: string }): Promise<unknown>;
};

export async function restoreOrchestratorConnection(
  client: AutoConnectClient,
  machines: SavedMachine[]
): Promise<boolean> {
  if (machines.length === 0) return false;

  try {
    await client.health();
    return false;
  } catch {
    let lastError: unknown;
    for (const machine of machines) {
      try {
        await client.connect({ connectionId: machine.id });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
