type SavedMachine = { id: string };

type AutoConnectClient = {
  health(): Promise<unknown>;
  connect(input: { connectionId: string }): Promise<unknown>;
};

export async function restoreOrchestratorConnection(
  client: AutoConnectClient,
  machines: SavedMachine[]
): Promise<boolean> {
  const [onlyMachine] = machines;
  if (machines.length !== 1 || !onlyMachine) return false;

  try {
    await client.health();
    return false;
  } catch {
    await client.connect({ connectionId: onlyMachine.id });
    return true;
  }
}
