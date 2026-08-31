import { describe, expect, it } from 'vitest';
import {
  activityDetail,
  activityTone,
  escapeCancelAction,
  shouldFollowOrcThread,
  transcriptLineTone,
  workingStatus,
} from './thread-panel';

describe('activityDetail', () => {
  const transcript = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].join('\n');

  it('keeps a compact head and tail while reporting truncated lines', () => {
    expect(activityDetail(transcript)).toEqual({
      hidden: 2,
      lines: ['first', 'fourth', 'fifth', 'sixth'],
    });
  });

  it('returns the complete transcript when expanded', () => {
    expect(activityDetail(transcript, true)).toEqual({
      hidden: 0,
      lines: ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'],
    });
  });
});

describe('terminal semantic colors', () => {
  it('colors tool activity by meaning and status', () => {
    expect(activityTone({ kind: 'command', status: 'completed' })).toBe('text-[#7dcfff]');
    expect(activityTone({ kind: 'file_change', status: 'completed' })).toBe('text-[#9ece6a]');
    expect(activityTone({ kind: 'tool', status: 'failed' })).toBe('text-[#f7768e]');
    expect(activityTone({ kind: 'web_search', status: 'in_progress' })).toBe('text-[#e0af68]');
  });

  it('colors diff and result transcript lines without changing their text', () => {
    expect(transcriptLineTone('+ added behavior')).toBe('text-[#9ece6a]');
    expect(transcriptLineTone('- removed behavior')).toBe('text-[#f7768e]');
    expect(transcriptLineTone('@@ changed hunk')).toBe('text-[#bb9af7]');
    expect(transcriptLineTone('12 tests passed')).toBe('text-[#9ece6a]');
    expect(transcriptLineTone('command failed')).toBe('text-[#f7768e]');
  });
});

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
