import { isLocalHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import {
  conversationRecordsSchema,
  conversationsContract,
} from '@emdash/core/runtimes/conversations/api';
import { createScope } from '@emdash/shared/concurrency';
import { remote, whenReady } from '@emdash/wire/state';
import type { AppDb } from '@core/services/app-db/node/db';
import type { ConversationsRuntimeBroker } from '../api/runtime-adapter';
import { throwConversationsRuntimeResolveError } from '../api/runtime-adapter';
import { linkConversationToTask } from './link-conversation-to-task';
import { applyConversationSnapshot } from './sync/apply-conversation-snapshot';

/** Atomically adopts a host-owned conversation snapshot and links its row to a desktop task. */
export async function adoptHostConversation(
  db: AppDb,
  runtimes: ConversationsRuntimeBroker,
  input: { host: HostRef; conversationId: string; projectId: string; taskId: string }
): Promise<boolean> {
  const { host, conversationId, projectId, taskId } = input;
  const client = await runtimes.client(host);
  if (!client.success) throwConversationsRuntimeResolveError(client.error);

  const scope = createScope({ label: 'conversation-explicit-refresh' });
  try {
    const records = remote(conversationsContract.records, client.data.conversations.records, {
      scope,
    });
    const state = records(undefined).states.list;
    const snapshot = await whenReady(state, { scope });
    const parsed = conversationRecordsSchema.parse(snapshot.value ?? {});
    if (!parsed[conversationId]) return false;
    await applyConversationSnapshot({
      db,
      host: isLocalHostRef(host)
        ? { location: 'local', sshConnectionId: null }
        : { location: 'remote', sshConnectionId: host.id },
      records: parsed,
    });
    await linkConversationToTask(db, { conversationId, projectId, taskId });
    return true;
  } finally {
    await scope.dispose();
  }
}
