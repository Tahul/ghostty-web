/**
 * WebGL renderer bookkeeping, against a WebGL2 context that records calls
 * instead of drawing (happy-dom has none): which rows are rebuilt, uploaded
 * and copied, what instances cells become, the Canvas2D fallback, and what
 * terminals share. Pixels are compared in a browser: bench/renderers.html.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from '../renderer';
import type { Terminal } from '../terminal';
import { createIsolatedTerminal } from '../test-helpers';
import { packColor, packRgb } from './color';
import { GLDevice } from './gl-device';
import { GlyphAtlas, type GlyphAtlasConfig, ShelfPacker } from './glyph-atlas';
import { WebGLRenderer } from './webgl-renderer';

type GLCall = { name: string; args: any[] };

const GL = {
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  RGBA8: 0x8058,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812f,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  READ_FRAMEBUFFER: 0x8ca8,
  COLOR_ATTACHMENT0: 0x8ce0,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_ROW_LENGTH: 0x0cf2,
  UNPACK_SKIP_PIXELS: 0x0cf4,
  UNPACK_SKIP_ROWS: 0x0cf3,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  TRIANGLE_STRIP: 0x0005,
  BLEND: 0x0be2,
  ONE: 1,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  SCISSOR_TEST: 0x0c11,
  MAX_TEXTURE_SIZE: 0x0d33,
};

/** A WebGL2 context that records its calls; WEBGL_lose_context fires the canvas events. */
function fakeWebGL2(canvas: HTMLCanvasElement) {
  const calls: GLCall[] = [];
  let lost = false;
  const loseContext = {
    loseContext() {
      calls.push({ name: 'loseContext', args: [] });
      lost = true;
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    },
    restoreContext() {
      lost = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
  const special: Record<string, unknown> = {
    canvas,
    calls,
    get drawingBufferWidth() {
      return Math.min(canvas.width, drawingBufferLimit);
    },
    get drawingBufferHeight() {
      return Math.min(canvas.height, drawingBufferLimit);
    },
    getParameter: (name: number) => (name === GL.MAX_TEXTURE_SIZE ? 4096 : 0),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? loseContext : null),
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
  };
  return new Proxy(special, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop in GL) return GL[prop as keyof typeof GL];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        return prop.startsWith('create') ? { kind: prop } : undefined;
      };
    },
  }) as any;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
let contexts: any[] = [];
/** The biggest drawing buffer the fake browser makes, in pixels per side. */
let drawingBufferLimit = Number.POSITIVE_INFINITY;
/** How much ink rasterized glyphs get: a small mark, or their whole box (fills atlases fast). */
let ink: 'mark' | 'box' = 'mark';

/** Glyph rasterization (2D contexts read back) yields ink where something was drawn. */
function inkGlyphs(ctx: any): void {
  let drawn = '';
  for (const name of ['fillText', 'fillRect', 'fill', 'stroke']) {
    const original = ctx[name];
    ctx[name] = (...args: any[]) => {
      // Spaces have no ink
      drawn = name === 'fillText' ? args[0].trim() : name;
      return original(...args);
    };
  }
  ctx.clearRect = () => {
    drawn = '';
  };
  ctx.getImageData = (_x: number, _y: number, width: number, height: number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    if (drawn) {
      // Emoji come out in color, everything else white
      const color = drawn === '🎉' ? [255, 0, 0, 255] : [255, 255, 255, 255];
      const [x0, y0, x1, y1] =
        ink === 'box'
          ? [0, 0, width, height]
          : [width >> 1, height >> 1, (width >> 1) + 2, (height >> 1) + 3];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) data.set(color, (y * width + x) * 4);
      }
    }
    return { data, width, height };
  };
}

function enableWebGL(): void {
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    options?: any
  ) {
    if (type === 'webgl2') {
      const gl = fakeWebGL2(this);
      contexts.push(gl);
      return gl;
    }
    const ctx = (originalGetContext as any).call(this, type, options);
    if (type === '2d' && options?.willReadFrequently) inkGlyphs(ctx);
    return ctx;
  } as any;
}

function renderNow(term: Terminal, forceAll = false): void {
  const t = term as any;
  t.renderer.render(t.wasmTerm, forceAll, t.viewportY, t, 0);
}

/** The visible canvas's drawImage calls (frame copies) from now on. */
function recordCopies(term: Terminal): any[][] {
  const copies: any[][] = [];
  const ctx = (term as any).renderer.ctx;
  ctx.drawImage = (...args: any[]) => copies.push(args);
  return copies;
}

/** The visible canvas's fillText calls (Canvas2D frames) from now on. */
function recordText(term: Terminal): string[] {
  const texts: string[] = [];
  const ctx = (term as any).renderer.ctx;
  const fillText = ctx.fillText;
  ctx.fillText = (text: string, ...rest: unknown[]) => {
    texts.push(text);
    return fillText(text, ...rest);
  };
  return texts;
}

/** The bytes r, g, b, a of a packed color. */
function bytes(color: number): number[] {
  return [...new Uint8Array(Uint32Array.of(color).buffer)];
}

describe('WebGLRenderer', () => {
  let container: HTMLElement;
  let terms: Terminal[] = [];

  async function open(options: Record<string, unknown> = {}): Promise<Terminal> {
    const term = await createIsolatedTerminal({ cols: 20, rows: 6, ...options });
    term.open(container);
    (term as any).cancelRenderLoop();
    terms.push(term);
    return term;
  }

  const renderer = (term: Terminal) => (term as any).renderer as any;
  const gl = () => contexts[contexts.length - 1];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    contexts = [];
    ink = 'mark';
    drawingBufferLimit = Number.POSITIVE_INFINITY;
  });

  afterEach(() => {
    for (const term of terms) term.dispose();
    terms = [];
    container.remove();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  test('draws with Canvas2D when WebGL2 is unavailable', async () => {
    const term = await open();
    expect(renderer(term)).toBeInstanceOf(WebGLRenderer);
    term.write('hi');
    const texts = recordText(term);
    renderNow(term, true);
    expect(renderer(term).usesGpu).toBe(false);
    expect(texts).toEqual(['h', 'i']);
  });

  test("renderer: 'canvas' never touches WebGL", async () => {
    enableWebGL();
    const term = await open({ renderer: 'canvas' });
    renderNow(term, true);
    expect(renderer(term)).toBeInstanceOf(CanvasRenderer);
    expect(renderer(term)).not.toBeInstanceOf(WebGLRenderer);
    expect(contexts).toHaveLength(0);
  });

  test('draws frames with the GPU and copies them onto its canvas', async () => {
    enableWebGL();
    const term = await open();
    term.write('hello');
    const copies = recordCopies(term);
    const texts = recordText(term);
    renderNow(term, true);
    expect(renderer(term).usesGpu).toBe(true);
    expect(texts).toEqual([]);
    const { width, height } = renderer(term).getCanvas();
    expect(copies).toEqual([[gl().canvas, 0, 0, width, height, 0, 0, width, height]]);
    const draws = gl().calls.filter((c: GLCall) => c.name === 'drawArraysInstanced');
    expect(draws[0].args).toEqual([GL.TRIANGLE_STRIP, 0, 4, 20 * 6]);
  });

  test('a change rebuilds, uploads and copies only its rows', async () => {
    enableWebGL();
    const term = await open();
    // The cursor waits on row 3, hidden (the rows it leaves and enters get drawn)
    term.write('\x1b[?25l\x1b[4;1H');
    renderNow(term, true);
    const copies = recordCopies(term);
    const calls: GLCall[] = gl().calls;
    calls.length = 0;
    term.write('x');
    renderNow(term);
    // Row 3 and its neighbours (glyphs overflow into them)
    const H = renderer(term).cellHeight;
    const width = renderer(term).getCanvas().width;
    expect(copies).toEqual([[gl().canvas, 0, 2 * H, width, 3 * H, 0, 2 * H, width, 3 * H]]);
    const uploads = calls.filter((c) => c.name === 'bufferSubData');
    expect(uploads.map((c) => [c.args[1], c.args[3], c.args[4]])).toEqual([
      [2 * 20 * 20, 2 * 20 * 5, 3 * 20 * 5],
    ]);
    // Background texels go up in whole rows (the atlas takes the new glyph's too)
    const texels = calls.filter((c) => c.name === 'texSubImage2D' && c.args[4] === 20);
    expect(texels.map((c) => c.args.slice(2, 6))).toEqual([[0, 2, 20, 3]]);

    // Nothing changed: nothing to do
    copies.length = 0;
    calls.length = 0;
    renderNow(term);
    expect(copies).toEqual([]);
    expect(calls.filter((c) => c.name.startsWith('draw'))).toEqual([]);
  });

  test('cells become glyph instances, background texels and lines', async () => {
    enableWebGL();
    const term = await open();
    term.write('\x1b[31mA\x1b[0m \x1b[4mu\x1b[0m\x1b[44mB\x1b[0m\x1b[2mf\x1b[0m\x1b[8mi\x1b[0m');
    renderNow(term, true);
    const r = renderer(term);
    const data = (term as any).wasmTerm.getViewportCellData();
    const glyph = (x: number) => Array.from(r.glyphData.subarray(x * 5, x * 5 + 5)) as number[];
    // 'A' in red: a quad with the cell's color; the space after it has none
    expect(glyph(0)[1]).not.toBe(0);
    expect(bytes(glyph(0)[3])).toEqual([...bytes(packRgb(data.fg[0])).slice(0, 3), 255]);
    expect(glyph(1)[1]).toBe(0);
    // Default background shows the theme's, 'B' its own
    expect(r.backgroundData[1]).toBe(r.colors.background);
    expect(r.backgroundData[3]).toBe(packRgb(data.bg[3]));
    // Faint text at half strength, invisible text not at all
    expect(bytes(glyph(4)[3])[3]).toBe(128);
    expect(glyph(5)[1]).toBe(0);
    // The underline under 'u': one cell wide, where the canvas renderer strokes it
    expect(r.rowRects[0]).toEqual([
      2 * r.cellWidth,
      r.underlineTop,
      r.cellWidth,
      r.lineThickness,
      packRgb(data.fg[2]),
    ]);
  });

  test('selection and inverse take the colors the canvas renderer gives them', async () => {
    enableWebGL();
    const term = await open({
      theme: {
        background: '#000000',
        selectionBackground: '#ff0000',
        selectionForeground: '#00ff00',
      },
    });
    term.write('ab\x1b[7mcd\x1b[0m');
    term.select(0, 0, 1);
    renderNow(term, true);
    const r = renderer(term);
    const data = (term as any).wasmTerm.getViewportCellData();
    expect(r.backgroundData[0]).toBe(packColor(255, 0, 0, 255));
    expect(bytes(r.glyphData[3])).toEqual([0, 255, 0, 255]);
    // Inverse: the foreground fills the cell, the text takes the background
    expect(r.backgroundData[2]).toBe(packRgb(data.fg[2]));
    expect(bytes(r.glyphData[2 * 5 + 3]).slice(0, 3)).toEqual(
      bytes(packRgb(data.bg[2])).slice(0, 3)
    );
  });

  test('a block cursor covers its cell and shows the glyph in the accent color', async () => {
    enableWebGL();
    const term = await open({ theme: { cursor: '#ffffff', cursorAccent: '#000000' } });
    term.write('ab\x1b[1;2H'); // cursor on 'b'
    renderNow(term, true);
    const r = renderer(term);
    const rects = r.frameRects as Uint32Array;
    // The cursor rect follows the row lines: none here, so it comes first
    expect(rects[0]).toBe((r.cellWidth & 0xffff) >>> 0);
    expect(bytes(rects[2])).toEqual([255, 255, 255, 255]);
    expect(Array.from(r.cursorGlyph.subarray(0, 3))).toEqual(
      Array.from(r.glyphData.subarray(5, 8))
    );
    expect(bytes(r.cursorGlyph[3])).toEqual([0, 0, 0, 255]);
  });

  test('draws each glyph once, through drawGlyph and built-in shapes', async () => {
    enableWebGL();
    const drawn: number[] = [];
    const term = await open({
      drawGlyph: (_ctx: unknown, cell: { codepoint: number }) => {
        drawn.push(cell.codepoint);
        return false;
      },
    });
    term.write('AAAA─────');
    renderNow(term, true);
    term.write('\r\nAA──');
    renderNow(term);
    expect(drawn).toEqual([0x41, 0x2500]);
    const r = renderer(term);
    expect(r.glyphData[1]).not.toBe(0);
    expect(r.glyphData[4 * 5 + 1]).not.toBe(0);
  });

  test('loses the GPU to Canvas2D and comes back to it', async () => {
    enableWebGL();
    const term = await open();
    term.write('hi');
    renderNow(term, true);
    const context = gl();
    context.getExtension('WEBGL_lose_context').loseContext();
    term.write('!');
    const texts = recordText(term);
    renderNow(term);
    // The whole screen again with Canvas2D (the GPU frames are gone)
    expect(renderer(term).usesGpu).toBe(false);
    expect(texts).toEqual(['h', 'i', '!']);

    context.getExtension('WEBGL_lose_context').restoreContext();
    const copies = recordCopies(term);
    texts.length = 0;
    renderNow(term);
    expect(renderer(term).usesGpu).toBe(true);
    expect(texts).toEqual([]);
    expect(copies).toHaveLength(1);
    expect(copies[0][4]).toBe(renderer(term).getCanvas().height);
  });

  test('a terminal bigger than the drawing buffer the browser allows draws with Canvas2D', async () => {
    enableWebGL();
    drawingBufferLimit = 64;
    const term = await open();
    term.write('hi');
    const texts = recordText(term);
    renderNow(term, true);
    expect(renderer(term).usesGpu).toBe(false);
    expect(texts).toEqual(['h', 'i']);
  });

  test('terminals share one WebGL context, and an atlas per font', async () => {
    enableWebGL();
    const a = await open();
    const b = await open();
    const c = await open({ fontSize: 20 });
    for (const term of [a, b, c]) renderNow(term, true);
    expect(contexts).toHaveLength(1);
    expect(renderer(a).atlas).toBe(renderer(b).atlas);
    expect(renderer(c).atlas).not.toBe(renderer(a).atlas);

    // The last one out frees the GPU memory
    const context = gl();
    for (const term of terms) term.dispose();
    terms = [];
    expect(context.calls.some((call: GLCall) => call.name === 'loseContext')).toBe(true);
    expect((GLDevice as any).current).toBeNull();
  });
});

describe('ShelfPacker', () => {
  test('packs boxes in shelves of similar heights', () => {
    const packer = new ShelfPacker(100, 100);
    expect(packer.allocate(40, 10)).toEqual({ x: 0, y: 0 });
    expect(packer.allocate(40, 10)).toEqual({ x: 40, y: 0 });
    // No room left on that shelf
    expect(packer.allocate(40, 10)).toEqual({ x: 0, y: 10 });
    // Much taller: a shelf of its own
    expect(packer.allocate(10, 30)).toEqual({ x: 0, y: 20 });
    // A little shorter fits a shelf already there
    expect(packer.allocate(10, 9)).toEqual({ x: 80, y: 0 });
    expect(packer.usedHeight).toBe(50);
    expect(packer.allocate(10, 60)).toBeNull();
    expect(packer.allocate(101, 1)).toBeNull();
    packer.reset();
    expect(packer.allocate(10, 60)).toEqual({ x: 0, y: 0 });
  });
});

describe('GlyphAtlas', () => {
  const config: GlyphAtlasConfig = {
    fonts: [
      '15px monospace',
      'bold 15px monospace',
      'italic 15px monospace',
      'bold italic 15px monospace',
    ],
    devicePixelRatio: 1,
    cellWidth: 40,
    cellHeight: 60,
    baseline: 45,
    customGlyphs: true,
  };

  beforeEach(() => {
    contexts = [];
    enableWebGL();
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    ink = 'mark';
  });

  test('trims glyphs to their ink and flags color glyphs', () => {
    const gl = fakeWebGL2(document.createElement('canvas'));
    const atlas = new GlyphAtlas(gl, config);
    const a = atlas.getCodepoint(0x41, 0, 1);
    // The mark is 2x3 at the middle of the 120x120 scratch box, which has a cell of room around the cell
    expect([a.width, a.height, a.left, a.top, a.colored]).toEqual([2, 3, 20, 30, false]);
    expect(atlas.getCodepoint(0x41, 0, 1)).toBe(a);
    expect(atlas.getCodepoint(0x41, 1, 1)).not.toBe(a);
    expect(atlas.getText('🎉', 0, 2).colored).toBe(true);
    expect(atlas.getCodepoint(0x20, 0, 1).width).toBe(0);
  });

  test('grows, keeping its glyphs, then starts over when full', () => {
    ink = 'box';
    const gl = fakeWebGL2(document.createElement('canvas'));
    const atlas = new GlyphAtlas(gl, config);
    const first = atlas.getCodepoint(0x100, 0, 1);
    let codepoint = 0x101;
    while (!gl.calls.some((c: GLCall) => c.name === 'copyTexSubImage2D'))
      atlas.getCodepoint(codepoint++, 0, 1);
    // Grown: the old texture is copied into a taller one, glyphs stay put
    expect(atlas.getCodepoint(0x100, 0, 1)).toBe(first);
    expect(atlas.generation).toBe(0);
    while (atlas.generation === 0) atlas.getCodepoint(codepoint++, 0, 1);
    // Full: everything is drawn again when asked for
    expect(atlas.getCodepoint(0x100, 0, 1)).not.toBe(first);
  });
});
