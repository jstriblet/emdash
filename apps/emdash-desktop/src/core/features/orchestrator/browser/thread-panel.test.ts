import { describe, expect, it } from 'vitest';
import { shouldFollowOrcThread } from './thread-panel';

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
