import { describe, expect, it } from 'vitest';
import {
  hasOnlyDisposableProjectTasks,
  isEmptyOrOnlyTerminalTask,
  isOnlyTaskInProject,
  selectProjectionMachineId,
  shouldAdoptHostConversation,
} from './project-worker-projection';

describe('selectProjectionMachineId', () => {
  const machines = [
    {
      id: 'connection-by-ip',
      name: '192.168.1.195',
      host: '192.168.1.195',
      sshConfigAlias: null,
    },
  ];

  it('reuses a sibling project connection when the logical host name differs', () => {
    const projects = [
      {
        data: {
          type: 'ssh',
          path: '/home/striblet/src/bookscape',
          connectionId: 'connection-by-ip',
        },
      },
    ];

    expect(
      selectProjectionMachineId(machines, projects, '/home/striblet/src/emdash', 'thinkcenter')
    ).toBe('connection-by-ip');
  });

  it('prefers an exact machine identity when one exists', () => {
    expect(
      selectProjectionMachineId(
        [
          ...machines,
          { id: 'thinkcenter', name: 'ThinkCenter', host: 'server', sshConfigAlias: null },
        ],
        [],
        '/home/striblet/src/emdash',
        'thinkcenter'
      )
    ).toBe('thinkcenter');
  });
});

describe('shouldAdoptHostConversation', () => {
  it('re-adopts a conversation when a server restart invalidates the local projection', () => {
    expect(shouldAdoptHostConversation(true, false)).toBe(true);
  });

  it('does not re-adopt a conversation that remains hydrated', () => {
    expect(shouldAdoptHostConversation(true, true)).toBe(false);
  });
});

describe('isOnlyTaskInProject', () => {
  it('allows project cleanup when the completed Orc task is the only task', () => {
    expect(isOnlyTaskInProject(['orc-task'], 'orc-task')).toBe(true);
  });

  it('preserves a project containing another task', () => {
    expect(isOnlyTaskInProject(['orc-task', 'other-task'], 'orc-task')).toBe(false);
  });
});

describe('isEmptyOrOnlyTerminalTask', () => {
  it('cleans an empty project whose Orc task was already removed', () => {
    expect(isEmptyOrOnlyTerminalTask([], 'orc-task')).toBe(true);
  });

  it('does not clean a project when another task remains', () => {
    expect(isEmptyOrOnlyTerminalTask(['other-task'], 'orc-task')).toBe(false);
  });
});

describe('hasOnlyDisposableProjectTasks', () => {
  it('ignores a settled unregistered placeholder during Orc cleanup', () => {
    expect(
      hasOnlyDisposableProjectTasks(
        [{ data: { id: 'placeholder' }, state: 'unregistered', phase: 'create-error' }],
        'orc-task'
      )
    ).toBe(true);
  });

  it('preserves any registered task that could contain manual work', () => {
    expect(
      hasOnlyDisposableProjectTasks(
        [{ data: { id: 'manual-task' }, state: 'provisioned', phase: null }],
        'orc-task'
      )
    ).toBe(false);
  });

  it('preserves a placeholder while task creation is in progress', () => {
    expect(
      hasOnlyDisposableProjectTasks(
        [{ data: { id: 'creating-task' }, state: 'unregistered', phase: 'creating' }],
        'orc-task'
      )
    ).toBe(false);
  });
});
