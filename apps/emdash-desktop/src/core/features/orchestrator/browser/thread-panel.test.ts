import { describe, expect, it } from 'vitest';
import { escapeCancelAction, shouldFollowOrcThread, workingStatus } from './thread-panel';

describe('shouldFollowOrcThread', () => {
  it('keeps the submitted turn pinned while Orc is working', () => {
    expect(shouldFollowOrcThread(true, 500)).toBe(true);
  });

  it('stops following background updates after the user scrolls away', () => {
    expect(shouldFollowOrcThread(false, 500)).toBe(false);
  });

  it('follows background updates while the viewport remains near the bottom', () => {
    expect(shouldFollowOrcThread(false, 20)).toBe(true);
  });
});

describe('escapeCancelAction', () => {
  it('shows confirmation on the first Escape while Orc is working', () => {
    expect(escapeCancelAction(true, false)).toBe('confirm');
  });

  it('cancels only on a second Escape while confirmation is visible', () => {
    expect(escapeCancelAction(true, true)).toBe('cancel');
  });

  it('interrupts immediately when a follow-up is queued', () => {
    expect(escapeCancelAction(true, false, true)).toBe('send-queued');
  });

  it('ignores Escape while Orc is idle', () => {
    expect(escapeCancelAction(false, false)).toBe('ignore');
  });
});

describe('workingStatus', () => {
  it('matches the Codex elapsed-time status style', () => {
    expect(workingStatus(12)).toBe('Working (12s • esc to interrupt)');
  });
});
