import { describe, expect, test } from 'bun:test';
import { createPtyOutput } from '../demo/bin/pty-stream.js';

/** Timers fired by hand, in order. */
function manualTimers() {
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  return {
    setTimer: (fn: () => void) => {
      const timer = { fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: unknown) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    fire() {
      const timer = timers.shift();
      if (timer && !timer.cleared) timer.fn();
    },
    get active() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

function setup(options: Record<string, number> = {}) {
  const sent: string[] = [];
  const events: string[] = [];
  const timers = manualTimers();
  const output = createPtyOutput({
    send: (chunk: Buffer) => sent.push(chunk.toString()),
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options,
  });
  return { output, sent, events, timers };
}

describe('demo PTY output', () => {
  test('the first chunk after a quiet spell goes out at once', () => {
    const { output, sent } = setup();
    output.push(Buffer.from('echo'));
    expect(sent).toEqual(['echo']);
  });

  test('chunks within the batch window are sent together', () => {
    const { output, sent, timers } = setup();
    output.push(Buffer.from('a'));
    output.push(Buffer.from('b'));
    output.push(Buffer.from('c'));
    expect(sent).toEqual(['a']);
    timers.fire(); // window ends with data: sent, and a new window opens
    expect(sent).toEqual(['a', 'bc']);
    timers.fire(); // quiet window: closes
    expect(timers.active).toBe(0);
    output.push(Buffer.from('d'));
    expect(sent).toEqual(['a', 'bc', 'd']);
  });

  test('a batch reaching maxBatchBytes goes out without waiting', () => {
    const { output, sent } = setup({ maxBatchBytes: 4 });
    output.push(Buffer.from('a'));
    output.push(Buffer.from('bb'));
    expect(sent).toEqual(['a']);
    output.push(Buffer.from('cc'));
    expect(sent).toEqual(['a', 'bbcc']);
  });

  test('pauses the PTY above the high watermark, resumes at the low one', () => {
    const { output, events, timers } = setup({ highWatermark: 10, lowWatermark: 4 });
    output.push(Buffer.from('123456'));
    output.push(Buffer.from('789012'));
    expect(events).toEqual([]);
    timers.fire();
    expect(output.unacknowledged).toBe(12);
    expect(events).toEqual(['pause']);
    output.ack(5);
    expect(events).toEqual(['pause']);
    output.ack(3);
    expect(output.unacknowledged).toBe(4);
    expect(events).toEqual(['pause', 'resume']);
  });

  test('ignores invalid acknowledgements and never goes below zero', () => {
    const { output } = setup();
    output.push(Buffer.from('abc'));
    output.ack(Number.NaN);
    output.ack(-5);
    expect(output.unacknowledged).toBe(3);
    output.ack(100);
    expect(output.unacknowledged).toBe(0);
  });

  test('dispose drops pending output and its timer', () => {
    const { output, sent, timers } = setup();
    output.push(Buffer.from('a'));
    output.push(Buffer.from('b'));
    output.dispose();
    timers.fire();
    output.push(Buffer.from('c'));
    expect(sent).toEqual(['a']);
  });
});
