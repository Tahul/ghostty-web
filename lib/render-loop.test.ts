/**
 * Render scheduling and drawing tests: frames only when something changed,
 * only changed rows copied out of the render state, and the canvas calls a
 * frame makes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';
import type { GhosttyCell } from './types';

type Call = { op: string; args: unknown[]; fill: unknown };

/** Records the drawing calls made on the terminal's canvas context. */
function record(term: Terminal): Call[] {
  const calls: Call[] = [];
  const ctx = (term as any).renderer.ctx;
  for (const op of ['fillRect', 'clearRect', 'fillText', 'stroke']) {
    const original = ctx[op];
    ctx[op] = (...args: unknown[]) => {
      calls.push({ op, args, fill: ctx.fillStyle });
      return original(...args);
    };
  }
  return calls;
}

/** Counts the renderer's render() calls. */
function countRenders(term: Terminal): { count: number } {
  const counter = { count: 0 };
  const renderer = (term as any).renderer;
  const render = renderer.render.bind(renderer);
  renderer.render = (...args: unknown[]) => {
    counter.count++;
    return render(...args);
  };
  return counter;
}

const frames = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function renderNow(term: Terminal, forceAll = false): void {
  const t = term as any;
  t.renderer.render(t.wasmTerm, forceAll, t.viewportY, t, 0);
}

describe('Render scheduling', () => {
  let term: Terminal;
  let container: HTMLElement;

  async function open(options: Record<string, unknown> = {}): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10, ...options });
    term.open(container);
    return term;
  }

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('an idle terminal draws no frames', async () => {
    await open();
    term.write('hello\r\nworld');
    await frames();
    const renders = countRenders(term);
    const calls = record(term);
    await frames(100);
    expect(renders.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a write schedules one frame', async () => {
    await open();
    await frames();
    const renders = countRenders(term);
    term.write('a');
    term.write('b');
    await frames();
    expect(renders.count).toBe(1);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('ab');
  });

  test('cursor blink ticks draw frames, about two a second', async () => {
    await open({ cursorBlink: true });
    await frames();
    const renders = countRenders(term);
    await frames(1200);
    expect(renders.count).toBeGreaterThanOrEqual(1);
    expect(renders.count).toBeLessThanOrEqual(3);
  });

  test('cancelRenderLoop stops frames until startRenderLoop, which draws at once', async () => {
    await open();
    await frames();
    const renders = countRenders(term);
    (term as any).cancelRenderLoop();
    term.write('paused');
    await frames();
    expect(renders.count).toBe(0);
    (term as any).startRenderLoop();
    expect(renders.count).toBe(1);
  });

  test('hovering a link requests a frame', async () => {
    await open();
    term.write('http://example.com');
    await frames();
    const renders = countRenders(term);
    (term as any).renderer.setHoveredLinkRange({ startX: 0, startY: 0, endX: 17, endY: 0 });
    await frames();
    expect(renders.count).toBe(1);
  });

  test('scrolling requests a frame', async () => {
    await open();
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    await frames();
    // The scrollbar fade draws its own frames; count the loop's requests
    const t = term as any;
    let requests = 0;
    const requestRender = t.requestRender.bind(t);
    t.requestRender = () => {
      requests++;
      requestRender();
    };
    term.scrollLines(-5);
    expect(requests).toBe(1);
  });
});

describe('Frame contents', () => {
  let term: Terminal;
  let container: HTMLElement;

  async function open(options: Record<string, unknown> = {}): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10, ...options });
    term.open(container);
    (term as any).cancelRenderLoop();
    return term;
  }

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('a frame with nothing changed draws nothing, cursor included', async () => {
    await open();
    term.write('prompt$ ');
    renderNow(term);
    const calls = record(term);
    renderNow(term);
    expect(calls).toHaveLength(0);
  });

  test('a scrolled-up viewport is drawn once, not every frame', async () => {
    await open();
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    renderNow(term);
    term.scrollLines(-5);
    renderNow(term);
    const calls = record(term);
    renderNow(term);
    expect(calls).toHaveLength(0);
  });

  test('a moved cursor redraws the rows around its old and new places only', async () => {
    await open();
    term.write('one\r\ntwo\r\nthree\r\n\r\n\r\n\r\nseven');
    renderNow(term);
    const calls = record(term);
    term.write('\x1b[2;1H'); // cursor to row 1: no cell changes
    renderNow(term);
    const height = (term as any).renderer.charHeight;
    const cleared = calls
      .filter((c) => c.op === 'clearRect')
      .map((c) => (c.args[1] as number) / height);
    expect(cleared).toContain(1);
    expect(cleared).toContain(6);
    expect(cleared.every((row) => row <= 2 || row >= 5)).toBe(true);
    expect(calls.some((c) => c.op === 'fillRect' && c.fill === '#ffffff')).toBe(true); // cursor
  });

  test('cells on the theme background get no fill; true black does', async () => {
    await open({ theme: { background: '#1e1e1e' } });
    term.write('ab \x1b[48;2;0;0;0mK\x1b[0m \x1b[44mxy\x1b[0m');
    const calls = record(term);
    renderNow(term, true);
    const row0 = calls.filter((c) => c.op === 'fillRect' && c.args[1] === 0);
    // Row fill, black cell, one rect for the two blue cells, block cursor
    expect(row0.map((c) => c.fill)).toEqual([
      '#1e1e1e',
      'rgb(0, 0, 0)',
      expect.stringMatching(/^rgb\(/),
      '#ffffff',
    ]);
    const width = (term as any).renderer.charWidth;
    expect(row0[2].args[2]).toBe(2 * width);
  });

  test('blank cells draw no text', async () => {
    await open();
    term.write('a  b');
    const calls = record(term);
    renderNow(term, true);
    expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual(['a', 'b']);
  });

  test('ASCII of one style is drawn as one string when the context can', async () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      const ctx = (getContext as any).apply(this, args);
      if (ctx) ctx.textRendering = 'auto';
      return ctx;
    } as any;
    try {
      await open();
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    term.write('hello world  \x1b[1mbold\x1b[0m \x1b[4mu\x1b[0m');
    const calls = record(term);
    renderNow(term, true);
    const texts = calls.filter((c) => c.op === 'fillText');
    expect(texts.map((c) => c.args[0])).toEqual(['hello world', 'bold', 'u']);
    const width = (term as any).renderer.charWidth;
    expect(texts[1].args[1]).toBe(13 * width);
  });
});

describe('drawGlyph option', () => {
  let term: Terminal;
  let container: HTMLElement;

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('draws the glyphs it takes and leaves the rest to fillText', async () => {
    const seen: Array<{ codepoint: number; x: number; color: string }> = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({
      cols: 20,
      rows: 4,
      // Box drawing would otherwise be drawn as shapes, not text
      customGlyphs: false,
      drawGlyph: (_ctx, cell: GhosttyCell, x, _y, _w, _h, color) => {
        seen.push({ codepoint: cell.codepoint, x, color });
        return cell.codepoint === 0x2500;
      },
    });
    term.open(container);
    (term as any).cancelRenderLoop();
    term.write('\x1b[31m─\x1b[0m│A');
    const calls = record(term);
    renderNow(term, true);
    const width = (term as any).renderer.charWidth;
    expect(seen.slice(0, 2)).toEqual([
      { codepoint: 0x2500, x: 0, color: expect.stringMatching(/^rgb\(/) },
      { codepoint: 0x2502, x: width, color: expect.stringMatching(/^rgb\(/) },
    ]);
    expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual(['│', 'A']);
  });
});

describe('Canvas sizing and built-in glyphs', () => {
  let term: Terminal;
  let container: HTMLElement;

  async function open(options: Record<string, unknown> = {}): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 20, rows: 6, ...options });
    term.open(container);
    (term as any).cancelRenderLoop();
    return term;
  }

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('box drawing, blocks and braille are drawn as shapes, not text', async () => {
    await open();
    term.write('─│█⣿A');
    const calls = record(term);
    renderNow(term, true);
    expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual(['A']);
    // In the text color: two arms each for ─ and │, one block, eight braille dots
    const shapes = calls.filter((c) => c.op === 'fillRect' && /^rgb\(/.test(String(c.fill)));
    expect(shapes).toHaveLength(13);
  });

  test('fractional pixel ratios size the canvas in whole pixels, once', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.1, configurable: true });
    try {
      await open({ renderer: 'canvas' });
    } finally {
      if (original) Object.defineProperty(window, 'devicePixelRatio', original);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    }
    const renderer = (term as any).renderer;
    const canvas = renderer.getCanvas();
    expect(Number.isInteger(canvas.width) && Number.isInteger(canvas.height)).toBe(true);
    let resizes = 0;
    const resize = renderer.resize.bind(renderer);
    renderer.resize = (...args: [number, number]) => {
      resizes++;
      resize(...args);
    };
    term.write('a');
    renderNow(term);
    term.write('b');
    renderNow(term);
    expect(resizes).toBe(0);
  });
});

describe('Viewport reads', () => {
  let term: Terminal;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 20, rows: 6 });
    term.open(container);
    (term as any).cancelRenderLoop();
  });

  afterEach(() => {
    term?.dispose();
    container?.remove();
  });

  test('an update copies only the rows that changed, once', () => {
    const wasm = (term as any).wasmTerm;
    term.write('one\r\ntwo');
    wasm.update();
    wasm.markClean();
    const exports = wasm.exports;
    const cellsRaw = wasm.layout.row.CELLS_RAW;
    let rowsCopied = 0;
    wasm.exports = {
      ...exports,
      ghostty_render_state_row_get: (iterator: number, data: number, out: number) => {
        if (data === cellsRaw) rowsCopied++;
        return exports.ghostty_render_state_row_get(iterator, data, out);
      },
    };
    term.write('!');
    for (let y = 0; y < 6; y++) wasm.getLine(y);
    expect(rowsCopied).toBe(1);
    expect(wasm.getLine(1).map((c: GhosttyCell) => c.codepoint)[3]).toBe(0x21);
    expect(rowsCopied).toBe(1);
  });

  test('getLine returns copies', () => {
    term.write('abc');
    const wasm = (term as any).wasmTerm;
    const line = wasm.getLine(0);
    line[0].codepoint = 0x5a;
    expect(wasm.getLine(0)[0].codepoint).toBe(0x61);
  });

  test('writes reuse one wasm buffer and keep multibyte text intact', () => {
    const wasm = (term as any).wasmTerm;
    term.write('warm');
    const exports = wasm.exports;
    let allocs = 0;
    wasm.exports = {
      ...exports,
      ghostty_wasm_alloc: (...args: unknown[]) => {
        allocs++;
        return exports.ghostty_wasm_alloc(...args);
      },
    };
    term.write('\r\x1b[Kéà 日本 🎉');
    term.write(new TextEncoder().encode(' ok'));
    expect(allocs).toBe(0);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('éà 日本 🎉 ok');
  });

  test('a write drops cached links on changed rows only', async () => {
    term.write('http://a.example\r\nhttp://b.example');
    const detector = (term as any).linkDetector;
    const scrollback = term.getScrollbackLength();
    expect(await detector.getLinkAt(2, scrollback)).toBeDefined();
    expect(await detector.getLinkAt(2, scrollback + 1)).toBeDefined();
    (term as any).renderer.render((term as any).wasmTerm, true, 0, term, 0); // clean
    term.write('\x1b[2;1Hhttp://c.example');
    expect(detector.scannedRows.has(scrollback)).toBe(true);
    expect(detector.scannedRows.has(scrollback + 1)).toBe(false);
    const link = await detector.getLinkAt(2, scrollback + 1);
    expect(link?.text).toBe('http://c.example');
  });

  test('resize sizes the canvas once', () => {
    const canvas = (term as any).renderer.getCanvas();
    let widthSets = 0;
    let width = canvas.width;
    Object.defineProperty(canvas, 'width', {
      get: () => width,
      set: (value: number) => {
        widthSets++;
        width = value;
      },
      configurable: true,
    });
    term.resize(30, 6);
    expect(widthSets).toBe(1);
  });
});
