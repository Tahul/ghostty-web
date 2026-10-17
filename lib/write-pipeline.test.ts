/**
 * The write pipeline: short writes parse at once, long ones in slices between
 * tasks (so rendering and input keep running), in order, with callbacks once
 * parsed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

/** Text of screen row y (buffer rows count from the top of the scrollback). */
const lineText = (term: Terminal, y: number) => {
  const buffer = term.buffer.active;
  return buffer.getLine(buffer.length - term.rows + y)?.translateToString(true) ?? '';
};

/** Resolves once `predicate` holds, checking between tasks. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** About `bytes` of numbered lines, ending with `last`. */
function bigOutput(bytes: number, last: string): string {
  const line = `${'x'.repeat(70)}\r\n`;
  return line.repeat(Math.ceil(bytes / line.length)) + last;
}

describe('Write pipeline', () => {
  let term: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 80, rows: 5, scrollback: 100 });
    term.open(container);
  });

  afterEach(() => {
    term.dispose();
    container.remove();
  });

  test('a short write is parsed at once and calls back after', async () => {
    let called = false;
    term.write('hello', () => {
      called = true;
    });
    expect(lineText(term, 0)).toBe('hello');
    expect(called).toBe(false);
    await Promise.resolve();
    expect(called).toBe(true);
  });

  test('a long write is parsed in slices, letting other tasks run in between', async () => {
    let done = false;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    term.write(bigOutput(4 << 20, 'END'), () => {
      done = true;
    });
    // Not parsed yet: the write returned at once
    expect(done).toBe(false);
    await until(() => done);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(lineText(term, 4)).toBe('END');
  });

  test('writes behind a long one keep their order, and so do callbacks', async () => {
    const order: string[] = [];
    term.write(bigOutput(1 << 20, 'long'), () => order.push('long'));
    term.write('+short', () => order.push('short'));
    term.write(new TextEncoder().encode('+bytes'), () => order.push('bytes'));
    await until(() => order.length === 3);
    expect(order).toEqual(['long', 'short', 'bytes']);
    expect(lineText(term, 4)).toBe('long+short+bytes');
  });

  test('text split across slices stays intact', async () => {
    // Long enough to be sliced; the leading "a" puts slice ends inside
    // surrogate pairs (string) and inside UTF-8 sequences (bytes)
    const text = `a${'🎉'.repeat(300000)}\r\nok`;
    for (const data of [text, new TextEncoder().encode(text)]) {
      let done = false;
      term.write(data, () => {
        done = true;
      });
      expect(done).toBe(false);
      await until(() => done);
      expect(lineText(term, 4)).toBe('ok');
      // No replacement characters from a split sequence: only whole emoji
      for (let y = 0; y < 4; y++) expect(lineText(term, y)).toMatch(/^(🎉)+$/u);
    }
  });

  test('resize, clear and reset parse what was written before them first', () => {
    term.write(bigOutput(1 << 20, 'before resize'));
    term.resize(60, 5);
    expect(lineText(term, 4)).toBe('before resize');

    term.write(bigOutput(1 << 20, 'cleared'));
    term.clear();
    expect(lineText(term, 0)).toBe('');

    let called = false;
    term.write(bigOutput(1 << 20, 'reset'), () => {
      called = true;
    });
    term.reset();
    expect(called).toBe(true);
    expect(lineText(term, 0)).toBe('');
  });

  test('dispose drops queued writes', async () => {
    let called = false;
    term.write(bigOutput(2 << 20, 'never'), () => {
      called = true;
    });
    term.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(false);
  });
});
