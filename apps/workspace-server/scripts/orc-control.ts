import { createConnection } from 'node:net';
import { workspaceWireContract, PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { client, connect, streamTransport } from '@emdash/wire/rpc';
import { DEFAULT_WORKSPACE_SERVER_SOCKET_PATH } from '../src/daemon/paths';

type Request =
  | { command: 'launch'; input: Parameters<ReturnType<typeof wire>['orchestration']['launch']>[0] }
  | { command: 'get'; input: { executionId: string } }
  | { command: 'cancel'; input: { executionId: string } };

const socketPath =
  process.env['EMDASH_WORKSPACE_SERVER_SOCKET'] ?? DEFAULT_WORKSPACE_SERVER_SOCKET_PATH;
const request = JSON.parse(await readStdin()) as Request;
const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
  const candidate = createConnection(socketPath);
  candidate.once('connect', () => resolve(candidate));
  candidate.once('error', reject);
});
const transport = streamTransport(socket, socket);
const api = wire(transport);

try {
  const initialized = await api.initialize({
    protocolVersion: PROTOCOL_VERSION,
    client: { id: 'orc', appVersion: 'phase-5-dev' },
  });
  if (!initialized.success) throw new Error(JSON.stringify(initialized.error));
  const result =
    request.command === 'launch'
      ? await api.orchestration.launch(request.input)
      : request.command === 'get'
        ? await api.orchestration.get(request.input)
        : await api.orchestration.cancel(request.input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  transport.close?.();
  socket.destroy();
}

function wire(transport: ReturnType<typeof streamTransport>) {
  return client(workspaceWireContract, connect(transport));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
