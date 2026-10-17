/**
 * Built-in glyph shapes: drawn on whole device pixels, filling their cell so
 * lines join across cells.
 */

import { describe, expect, test } from 'bun:test';
import { drawCustomGlyph, isCustomGlyph } from './custom-glyphs';

type Rect = { x: number; y: number; w: number; h: number; alpha: number };

/** A 2D context that records fillRect in absolute units (translate/scale applied). */
function recorder() {
  const rects: Rect[] = [];
  const paths: string[] = [];
  const stack: Array<{ tx: number; ty: number; s: number; alpha: number }> = [];
  let tx = 0;
  let ty = 0;
  let s = 1;
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save() {
      stack.push({ tx, ty, s, alpha: ctx.globalAlpha });
    },
    restore() {
      const saved = stack.pop()!;
      ({ tx, ty, s } = saved);
      ctx.globalAlpha = saved.alpha;
    },
    translate(x: number, y: number) {
      tx += x * s;
      ty += y * s;
    },
    scale(factor: number) {
      s *= factor;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x: tx + x * s, y: ty + y * s, w: w * s, h: h * s, alpha: ctx.globalAlpha });
    },
    fill: () => paths.push('fill'),
    stroke: () => paths.push('stroke'),
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    ellipse() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, paths };
}

/** Rows of a picture: one line per pixel row, # filled, . empty. */
function picture(rows: string): string[] {
  return rows.trim().split(/\s+/);
}

/** Draws `char` in a 6x8 cell at device scale and returns its pixels as rows of # and . */
function pixels(char: string): string[] {
  const { ctx, rects } = recorder();
  expect(drawCustomGlyph(ctx, char.codePointAt(0)!, 0, 0, 6, 8, '#fff')).toBe(true);
  const grid = Array.from({ length: 8 }, () => Array(6).fill('.'));
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = '#';
    }
  }
  return grid.map((row) => row.join(''));
}

describe('Custom glyphs', () => {
  test('covers box drawing, blocks, shades, braille and Powerline', () => {
    for (const cp of [0x2500, 0x257f, 0x2580, 0x259f, 0x2800, 0x28ff, 0xe0b0, 0xe0b7]) {
      expect(isCustomGlyph(cp)).toBe(true);
    }
    for (const cp of [0x41, 0x24ff, 0x25a0, 0x27ff, 0x2900, 0xe0af, 0xe0b8]) {
      expect(isCustomGlyph(cp)).toBe(false);
    }
    const { ctx, rects } = recorder();
    expect(drawCustomGlyph(ctx, 0x41, 0, 0, 6, 8, '#fff')).toBe(false);
    expect(rects).toEqual([]);
  });

  test('lines run edge to edge through the cell center', () => {
    expect(pixels('─')).toEqual(
      picture(`
      ......
      ......
      ......
      ######
      ......
      ......
      ......
      ......
      `)
    );
    expect(pixels('│')).toEqual(Array(8).fill('..#...'));
    expect(pixels('┼')).toEqual(
      picture(`
      ..#...
      ..#...
      ..#...
      ######
      ..#...
      ..#...
      ..#...
      ..#...
      `)
    );
    expect(pixels('┌')).toEqual(
      picture(`
      ......
      ......
      ......
      ..####
      ..#...
      ..#...
      ..#...
      ..#...
      `)
    );
    expect(pixels('━')).toEqual(
      picture(`
      ......
      ......
      ......
      ######
      ######
      ......
      ......
      ......
      `)
    );
  });

  test('double lines have two rails that turn at corners', () => {
    expect(pixels('═')).toEqual(
      picture(`
      ......
      ......
      ######
      ......
      ######
      ......
      ......
      ......
      `)
    );
    expect(pixels('║')).toEqual(Array(8).fill('.#.#..'));
    expect(pixels('╔')).toEqual(
      picture(`
      ......
      ......
      .#####
      .#....
      .#.###
      .#.#..
      .#.#..
      .#.#..
      `)
    );
  });

  test('blocks fill their part of the cell, halves meet exactly', () => {
    expect(pixels('█')).toEqual(Array(8).fill('######'));
    expect(pixels('▀')).toEqual([...Array(4).fill('######'), ...Array(4).fill('......')]);
    expect(pixels('▄')).toEqual([...Array(4).fill('......'), ...Array(4).fill('######')]);
    expect(pixels('▌')).toEqual(Array(8).fill('###...'));
    expect(pixels('▐')).toEqual(Array(8).fill('...###'));
    expect(pixels('▚')).toEqual(
      picture(`
      ###...
      ###...
      ###...
      ###...
      ...###
      ...###
      ...###
      ...###
      `)
    );
  });

  test('shades fill the cell at a quarter, half and three quarters', () => {
    const alphas = ['░', '▒', '▓'].map((char) => {
      const { ctx, rects } = recorder();
      drawCustomGlyph(ctx, char.codePointAt(0)!, 0, 0, 6, 8, '#fff');
      expect(rects).toHaveLength(1);
      return rects[0].alpha;
    });
    expect(alphas).toEqual([0.25, 0.5, 0.75]);
  });

  test('braille draws one dot per raised bit', () => {
    expect(pixels('⣿')).toEqual(
      picture(`
      ......
      .#..#.
      ......
      .#..#.
      ......
      .#..#.
      ......
      .#..#.
      `)
    );
    expect(pixels('⠁').filter((row) => row.includes('#'))).toEqual(['.#....']);
  });

  test('Powerline shapes are filled, their outlines stroked', () => {
    const solid = recorder();
    drawCustomGlyph(solid.ctx, 0xe0b0, 0, 0, 6, 8, '#fff');
    expect(solid.paths).toEqual(['fill']);
    const outline = recorder();
    drawCustomGlyph(outline.ctx, 0xe0b1, 0, 0, 6, 8, '#fff');
    expect(outline.paths).toEqual(['stroke']);
  });

  test('cells at fractional pixel ratios share their edges', () => {
    // 9px cells at 1.5x are 13.5 device pixels: snapped, they alternate 14 and 13
    const { ctx, rects } = recorder();
    for (let col = 0; col < 3; col++)
      drawCustomGlyph(ctx, 0x2588, col * 9, 0, 9, 19, '#fff', 1 / 1.5);
    const spans = rects.map((r) => [Math.round(r.x * 1.5), Math.round((r.x + r.w) * 1.5)]);
    expect(spans).toEqual([
      [0, 14],
      [14, 27],
      [27, 41],
    ]);
  });
});
