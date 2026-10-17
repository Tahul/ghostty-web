/**
 * The bindings to upstream libghostty-vt: memory, scrollback, query replies,
 * effects, key encoding, cell decoding and synchronized output (render holds).
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { Ghostty, type GhosttyTerminal, RENDER_HOLD_TIMEOUT_MS } from './ghostty';
import { createIsolatedTerminal } from './test-helpers';
import { Key, KeyAction, Mods } from './types';

let ghostty: Ghostty;

beforeAll(async () => {
  ghostty = await Ghostty.load();
});

const text = (term: GhosttyTerminal, y: number) =>
  term
    .getLine(y)!
    .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
    .join('')
    .trimEnd();

const viewportText = (term: GhosttyTerminal, y: number) =>
  term
    .getViewportRowCells(y)!
    .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
    .join('')
    .trimEnd();

describe('Memory', () => {
  test('grapheme clusters scrolling through a full scrollback keep memory flat', async () => {
    const own = await Ghostty.load();
    const term = own.createTerminal(80, 24, { scrollbackLimit: 1000 });
    const line = new TextEncoder().encode(`${'e\u0301a\u0308👍🏽'.repeat(10)} line\r\n`.repeat(200));
    // Fill the scrollback, then keep writing: pruned pages must be reused or freed
    for (let i = 0; i < 20; i++) term.write(line);
    const filled = own.memory.buffer.byteLength;
    for (let i = 0; i < 200; i++) term.write(line);
    expect(own.memory.buffer.byteLength - filled).toBeLessThanOrEqual(1 << 20);
    term.free();
  });
});

describe('Scrollback', () => {
  const fill = (term: GhosttyTerminal, lines: number) => {
    const line = `${'x'.repeat(term.cols - 1)}\r\n`;
    for (let i = 0; i < lines / 1000; i++) term.write(line.repeat(1000));
  };

  test('keeps about as many lines as configured, at any width', () => {
    for (const cols of [80, 200]) {
      const term = ghostty.createTerminal(cols, 24, { scrollbackLimit: 10000 });
      fill(term, 25000);
      // Pruned a page at a time: a little under the limit
      expect(term.getScrollbackLength()).toBeGreaterThan(9000);
      expect(term.getScrollbackLength()).toBeLessThanOrEqual(10000);
      term.free();
    }
  });

  test('a limit of 0 keeps no scrollback', () => {
    const term = ghostty.createTerminal(80, 24, { scrollbackLimit: 0 });
    fill(term, 3000);
    expect(term.getScrollbackLength()).toBe(0);
    term.free();
  });

  test('scrollback lines read back with their text, colors and wrap state', () => {
    const term = ghostty.createTerminal(10, 3);
    term.write('\x1b[31mred\x1b[0m line\r\n0123456789wrapped\r\nx\r\ny\r\nz');
    expect(term.getScrollbackLength()).toBe(3);
    const first = term.getScrollbackLine(0)!;
    expect(first.slice(0, 3).map((c) => String.fromCodePoint(c.codepoint))).toEqual([
      'r',
      'e',
      'd',
    ]);
    expect(first[0].fg_r).toBeGreaterThan(first[0].fg_b);
    expect(term.isScrollbackRowWrapped(1)).toBe(false);
    expect(term.isScrollbackRowWrapped(2)).toBe(true);
    term.free();
  });

  test('scrolling the viewport shows the scrollback', () => {
    const term = ghostty.createTerminal(10, 2);
    term.write('a\r\nb\r\nc\r\nd');
    expect(term.getScrollbackLength()).toBe(2);
    term.scrollViewport(2);
    expect(viewportText(term, 0)).toBe('a');
    expect(viewportText(term, 1)).toBe('b');
    // The active area is still readable while scrolled
    expect(text(term, 1)).toBe('d');
    term.scrollViewport(0);
    expect(viewportText(term, 0)).toBe('c');
    term.free();
  });
});

describe('Query replies', () => {
  const reply = (query: string) => {
    const term = ghostty.createTerminal(80, 24);
    term.write(`ab\r\ncd${query}`);
    const response = term.readResponse();
    term.free();
    return response;
  };

  test('device attributes match what ghostty-web always reported', () => {
    expect(reply('\x1b[c')).toBe('\x1b[?62;22c');
    expect(reply('\x1b[>c')).toBe('\x1b[>1;10;0c');
  });

  test('cursor position and status reports', () => {
    expect(reply('\x1b[6n')).toBe('\x1b[2;3R');
    expect(reply('\x1b[5n')).toBe('\x1b[0n');
  });

  test('programs can detect synchronized output with DECRQM', () => {
    expect(reply('\x1b[?2026$p')).toBe('\x1b[?2026;2$y');
  });

  test('color queries report the configured colors', () => {
    const term = ghostty.createTerminal(80, 24, { fgColor: 0x112233, bgColor: 0xabcdef });
    term.write('\x1b]10;?\x07\x1b]11;?\x07');
    expect(term.readResponse()).toBe(
      '\x1b]10;rgb:1111/2222/3333\x07\x1b]11;rgb:abab/cdcd/efef\x07'
    );
    term.write('\x1b[?996n');
    expect(term.readResponse()).toBe('\x1b[?997;2n'); // light background
    term.free();
  });

  test('size reports use the cell size from resize()', () => {
    const term = ghostty.createTerminal(80, 24);
    term.resize(80, 24, 9, 18);
    term.write('\x1b[14t\x1b[18t');
    expect(term.readResponse()).toBe('\x1b[4;432;720t\x1b[8;24;80t');
    term.free();
  });
});

describe('Effects', () => {
  test('a BEL rings the bell, a BEL ending an OSC does not', async () => {
    const term = await createIsolatedTerminal();
    term.open(document.createElement('div'));
    let bells = 0;
    term.onBell(() => bells++);
    term.write('\x1b]0;title\x07');
    expect(bells).toBe(0);
    term.write('ding\x07');
    expect(bells).toBe(1);
    term.dispose();
  });

  test('titles come from OSC 0 and 2, whatever the terminator', async () => {
    const term = await createIsolatedTerminal();
    term.open(document.createElement('div'));
    const titles: string[] = [];
    term.onTitleChange((title) => titles.push(title));
    term.write('\x1b]2;first\x1b\\');
    term.write('\x1b]0;sécond ✓\x07');
    term.write('\x1b]0;sécond ✓\x07'); // unchanged: no event
    expect(titles).toEqual(['first', 'sécond ✓']);
    term.dispose();
  });
});

describe('Key encoding', () => {
  test('follows the modes and Kitty flags programs set', () => {
    const term = ghostty.createTerminal(80, 24);
    const encoder = ghostty.createKeyEncoder();
    const encode = (key: Key, mods = Mods.NONE) =>
      new TextDecoder().decode(encoder.encode({ action: KeyAction.PRESS, key, mods }));

    encoder.syncFromTerminal(term);
    expect(encode(Key.UP)).toBe('\x1b[A');
    term.write('\x1b[?1h'); // DECCKM
    encoder.syncFromTerminal(term);
    expect(encode(Key.UP)).toBe('\x1bOA');
    term.write('\x1b[>1u'); // Kitty: disambiguate escape codes
    encoder.syncFromTerminal(term);
    expect(encode(Key.ESCAPE)).toBe('\x1b[27u');

    encoder.dispose();
    term.free();
  });

  test('Key values match libghostty-vt', () => {
    // ghostty-web keeps its historical names; upstream renamed some keys
    const renamed: Record<string, string> = {
      GRAVE: 'BACKQUOTE',
      UP: 'ARROW_UP',
      DOWN: 'ARROW_DOWN',
      LEFT: 'ARROW_LEFT',
      RIGHT: 'ARROW_RIGHT',
      KP_PLUS: 'NUMPAD_ADD',
      KP_PERIOD: 'NUMPAD_DECIMAL',
      KP_MINUS: 'NUMPAD_SUBTRACT',
    };
    const digits = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    digits.forEach((name, i) => {
      renamed[name] = `DIGIT_${i}`;
    });
    const upstreamName = (name: string) =>
      renamed[name] ?? (name.startsWith('KP_') ? `NUMPAD_${name.slice(3)}` : name);
    for (const [name, value] of Object.entries(Key)) {
      if (typeof value !== 'number') continue;
      expect([name, ghostty.manifest.enumValue('GhosttyKey', upstreamName(name))]).toEqual([
        name,
        value,
      ]);
    }
  });
});

describe('Cells', () => {
  test('decode text, styles, wide characters, graphemes and links', () => {
    const term = ghostty.createTerminal(20, 3, { palette: [undefined, 0xff0000] });
    term.write(
      '\x1b[1;31mR\x1b[0m日\x1b]8;;https://x.y\x07L\x1b]8;;\x07e\u0301\x1b[48;2;0;0;0m \x1b[0m'
    );
    const row = term.getLine(0)!;
    expect(row[0]).toMatchObject({ codepoint: 0x52, fg_r: 0xff, fg_g: 0, fg_b: 0, flags: 1 });
    expect(row[1]).toMatchObject({ codepoint: 0x65e5, width: 2 });
    expect(row[2]).toMatchObject({ codepoint: 0, width: 0 });
    expect(row[3]).toMatchObject({ codepoint: 0x4c, hyperlink_id: 1 });
    expect(term.getHyperlinkUri(0, 3)).toBe('https://x.y');
    expect(row[4]).toMatchObject({ codepoint: 0x65, grapheme_len: 1 });
    expect(term.getGraphemeString(0, 4)).toBe('e\u0301');
    // True black stays distinct from the default background
    expect(row[5]).toMatchObject({ bg_r: 0, bg_g: 0, bg_b: 0 });
    expect(term.getDefaultBackground()).toBe(0x000000);
    term.setColors({ bgColor: 0x1e1e1e });
    expect(term.getLine(0)![6]).toMatchObject({ bg_r: 0x1e, bg_g: 0x1e, bg_b: 0x1e });
    expect(term.getLine(0)![5]).toMatchObject({ bg_r: 0, bg_g: 0, bg_b: 0 });
    term.free();
  });
});

describe('Synchronized output (render holds)', () => {
  test('the screen keeps the last frame while a program holds it', () => {
    const term = ghostty.createTerminal(10, 2);
    term.write('old');
    term.update();
    term.markClean();
    term.write('\x1b[?2026h\rnew');
    expect(term.renderHoldActive).toBe(true);
    expect(viewportText(term, 0)).toBe('old');
    term.write('\x1b[?2026l');
    expect(term.takeRenderHoldRelease()).toBe(true);
    expect(viewportText(term, 0)).toBe('new');
    term.free();
  });

  test('a frame finished and the next started in one write shows the finished one', () => {
    const term = ghostty.createTerminal(10, 2);
    term.write('\x1b[?2026h\rframe 1\x1b[?2026l\x1b[?2026h\rpartial');
    expect(viewportText(term, 0)).toBe('frame 1');
    expect(term.takeRenderHoldRelease()).toBe(true);
    // The live terminal has moved on
    expect(text(term, 0)).toBe('partial');
    term.free();
  });

  test(`a hold longer than ${RENDER_HOLD_TIMEOUT_MS} ms is released`, () => {
    const term = ghostty.createTerminal(10, 2);
    term.write('\x1b[?2026hstuck');
    expect(viewportText(term, 0)).toBe('');
    (term as any).holdStartedAt -= RENDER_HOLD_TIMEOUT_MS;
    expect(viewportText(term, 0)).toBe('stuck');
    expect(term.renderHoldActive).toBe(false);
    expect(term.getMode(2026)).toBe(false);
    term.free();
  });

  test('scrolling during a hold shows live content', () => {
    const term = ghostty.createTerminal(10, 2);
    term.write('a\r\nb\r\nc\x1b[?2026h\r\nd');
    // Held frame: b, c. Two lines up in the live scrollback: a, b.
    expect(viewportText(term, 0)).toBe('b');
    term.scrollViewport(2);
    expect(viewportText(term, 0)).toBe('a');
    expect(viewportText(term, 1)).toBe('b');
    term.free();
  });

  test('the terminal draws a finished frame during the write that finishes it', async () => {
    const term = await createIsolatedTerminal({ cols: 10, rows: 2 });
    term.open(document.createElement('div'));
    (term as any).cancelRenderLoop();
    const renderer = (term as any).renderer;
    let renders = 0;
    const render = renderer.render.bind(renderer);
    renderer.render = (...args: unknown[]) => {
      renders++;
      return render(...args);
    };
    term.write('\x1b[?2026hframe');
    expect(renders).toBe(0);
    term.write('\x1b[?2026l');
    expect(renders).toBe(1);
    term.dispose();
  });
});
