import { chmod, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const listenPath = process.env.EMDASH_ORC_PROXY_SOCKET ?? '/tmp/emdash-orc-workspace.sock';
const upstreamPath =
  process.env.EMDASH_ORC_UPSTREAM_SOCKET ??
  join(homedir(), '.emdash', 'workspace-server', 'run', 'workspace.sock');

await unlink(listenPath).catch(() => {});

const server = createServer((downstream) => {
  const upstream = createConnection(upstreamPath);
  downstream.on('error', () => upstream.destroy());
  upstream.on('error', () => downstream.destroy());
  downstream.pipe(upstream);
  upstream.pipe(downstream);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(listenPath, resolve);
});
await chmod(listenPath, 0o666);

const shutdown = async () => {
  await new Promise((resolve) => server.close(resolve));
  await unlink(listenPath).catch(() => {});
};

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
