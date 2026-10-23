import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalProgress } from '../progress.js';

afterEach(() => vi.useRealTimers());

describe('human terminal progress', () => {
  it('shows the active step immediately and elapsed waiting, then stops cleanly', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const progress = new TerminalProgress(line => lines.push(line));
    progress.start('Installing application files...');
    expect(lines).toEqual(['Installing application files...']);
    vi.advanceTimersByTime(10_000);
    expect(lines.at(-1)).toBe('  Still working (10s). Installing application files...');
    progress.start('Checking permissions...');
    vi.advanceTimersByTime(10_000);
    expect(lines.at(-1)).toBe('  Still working (10s). Checking permissions...');
    progress.stop();
    const count = lines.length;
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps machine-readable and redirected execution free of progress text and timers', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = new TerminalProgress(write, false);
    progress.start('Installing...');
    vi.advanceTimersByTime(60_000);
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
