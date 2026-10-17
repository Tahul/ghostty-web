/**
 * Glyphs rasterized once with Canvas2D and kept in a texture, for the
 * WebGL renderer to draw as textured quads.
 *
 * Glyphs are drawn in white and trimmed to their ink: the renderer tints them
 * per cell. Glyphs drawn in other colors (emoji) are flagged and keep theirs.
 * Each glyph is drawn into a cell-sized box with room around it, so overhangs
 * (italics, accents, wide emoji) survive and are drawn past the cell.
 */

import { drawCustomGlyph } from '../custom-glyphs';
import type { GlyphDrawer } from '../renderer';
import { CellFlags, type GhosttyCell } from '../types';
import type { SharedGLResource } from './gl-device';

/** A glyph in the atlas. Zero width and height for glyphs without ink (spaces). */
export interface Glyph {
  /** Position in the atlas, in pixels */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Offset of the glyph's top-left corner from its cell's, in pixels */
  readonly left: number;
  readonly top: number;
  /** Drawn in its own colors (emoji): not tinted */
  readonly colored: boolean;
}

/** How glyphs are drawn: everything a glyph's pixels depend on. */
export interface GlyphAtlasConfig {
  /** The font of each style: index bit 0 bold, bit 1 italic */
  fonts: readonly string[];
  devicePixelRatio: number;
  /** Cell size and baseline, in device pixels */
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  customGlyphs: boolean;
  drawGlyph?: GlyphDrawer;
}

const EMPTY: Glyph = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, colored: false };

const ATLAS_WIDTH = 1024;
const INITIAL_HEIGHT = 256;
const MAX_HEIGHT = 4096;

/**
 * Packs boxes into rows ("shelves") of similar heights, top to bottom.
 */
export class ShelfPacker {
  private shelves: Array<{ y: number; height: number; x: number }> = [];
  /** Height used so far: the top of the next shelf */
  usedHeight = 0;

  constructor(
    readonly width: number,
    readonly maxHeight: number
  ) {}

  /** A place for a `width` x `height` box, or null when the area is full. */
  allocate(width: number, height: number): { x: number; y: number } | null {
    if (width > this.width) return null;
    // The lowest shelf that fits without wasting much of its height
    let best: { y: number; height: number; x: number } | null = null;
    for (const shelf of this.shelves) {
      if (shelf.height < height || shelf.height > height + Math.max(4, height >> 2)) continue;
      if (shelf.x + width > this.width) continue;
      if (!best || shelf.height < best.height) best = shelf;
    }
    if (!best) {
      if (this.usedHeight + height > this.maxHeight) return null;
      best = { y: this.usedHeight, height, x: 0 };
      this.shelves.push(best);
      this.usedHeight += height;
    }
    const place = { x: best.x, y: best.y };
    best.x += width;
    return place;
  }

  reset(): void {
    this.shelves = [];
    this.usedHeight = 0;
  }
}

/** Scratch canvas glyphs are drawn on before they go to the texture (shared, single-threaded). */
let scratch: CanvasRenderingContext2D | null = null;

function scratchContext(width: number, height: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    const canvas = document.createElement('canvas');
    scratch = canvas.getContext('2d', { willReadFrequently: true });
    if (!scratch) return null;
  }
  const canvas = scratch.canvas;
  if (canvas.width < width || canvas.height < height) {
    canvas.width = Math.max(canvas.width, width);
    canvas.height = Math.max(canvas.height, height);
  }
  return scratch;
}

/** Ids for glyph drawers, so atlases are shared only between terminals using the same one. */
const drawerIds = new WeakMap<GlyphDrawer, number>();
let nextDrawerId = 1;

export class GlyphAtlas implements SharedGLResource {
  /** The key atlases are shared by: terminals with the same key draw the same glyphs. */
  static key(config: GlyphAtlasConfig): string {
    let drawer = 0;
    if (config.drawGlyph) {
      drawer = drawerIds.get(config.drawGlyph) ?? nextDrawerId++;
      drawerIds.set(config.drawGlyph, drawer);
    }
    return [
      ...config.fonts,
      config.devicePixelRatio,
      config.cellWidth,
      config.cellHeight,
      config.baseline,
      config.customGlyphs ? 1 : 0,
      drawer,
    ].join('|');
  }

  /**
   * Bumped when glyphs move (the atlas was cleared): glyph positions taken
   * before are stale.
   */
  generation = 0;
  texture: WebGLTexture | null = null;
  private height = INITIAL_HEIGHT;
  private readonly packer: ShelfPacker;
  /** Single-codepoint glyphs by codepoint, style and width (see codepointKey) */
  private readonly byCodepoint = new Map<number, Glyph>();
  /** Grapheme clusters by style, width and text */
  private readonly byText = new Map<string, Glyph>();
  private readonly cell: GhosttyCell = {
    codepoint: 0,
    fg_r: 255,
    fg_g: 255,
    fg_b: 255,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly config: GlyphAtlasConfig
  ) {
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.packer = new ShelfPacker(
      Math.min(ATLAS_WIDTH, maxSize || ATLAS_WIDTH),
      Math.min(MAX_HEIGHT, maxSize || MAX_HEIGHT)
    );
    this.texture = this.createTexture(this.height);
  }

  /** The glyph of one codepoint; `style` bit 0 bold, bit 1 italic; `width` in cells. */
  getCodepoint(codepoint: number, style: number, width: number): Glyph {
    const key = codepoint * 8 + style * 2 + (width === 2 ? 1 : 0);
    let glyph = this.byCodepoint.get(key);
    if (!glyph) {
      glyph = this.rasterize(String.fromCodePoint(codepoint), codepoint, style, width);
      this.byCodepoint.set(key, glyph);
    }
    return glyph;
  }

  /** The glyph of a grapheme cluster (a base and its combining marks, an emoji sequence). */
  getText(text: string, style: number, width: number): Glyph {
    const key = `${style}${width}${text}`;
    let glyph = this.byText.get(key);
    if (!glyph) {
      glyph = this.rasterize(text, text.codePointAt(0) ?? 0, style, width);
      this.byText.set(key, glyph);
    }
    return glyph;
  }

  /** Forgets every glyph (they get drawn again when asked for), e.g. once a web font loaded. */
  reset(): void {
    if (this.byCodepoint.size > 0 || this.byText.size > 0) this.clear();
  }

  contextRestored(): void {
    this.height = INITIAL_HEIGHT;
    this.texture = this.createTexture(this.height);
    this.clear();
  }

  private clear(): void {
    this.byCodepoint.clear();
    this.byText.clear();
    this.packer.reset();
    this.generation++;
  }

  dispose(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
  }

  private createTexture(height: number): WebGLTexture | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.packer.width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Doubles the texture height (up to what was packed), keeping its glyphs where they are. */
  private grow(minHeight: number): void {
    const gl = this.gl;
    let height = this.height;
    while (height < minHeight) height *= 2;
    height = Math.min(height, this.packer.maxHeight);
    const texture = this.createTexture(height);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.READ_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0
    );
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.packer.width, this.height);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = texture;
    this.height = height;
  }

  /** Draws a glyph, trims it to its ink and adds it to the texture. */
  private rasterize(text: string, codepoint: number, style: number, width: number): Glyph {
    const { cellWidth, cellHeight, devicePixelRatio: dpr } = this.config;
    // Room for overhangs: a cell on each side, half a cell above and below
    const padX = cellWidth;
    const padY = Math.ceil(cellHeight / 2);
    const boxWidth = cellWidth * width;
    const scratchWidth = boxWidth + 2 * padX;
    const scratchHeight = cellHeight + 2 * padY;
    const ctx = scratchContext(scratchWidth, scratchHeight);
    if (!ctx) return EMPTY;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, scratchWidth, scratchHeight);
    // CSS pixels from the cell's top-left corner, as the canvas renderer draws
    ctx.setTransform(dpr, 0, 0, dpr, padX, padY);
    ctx.font = this.config.fonts[style];
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    this.drawGlyphText(ctx, text, codepoint, style, width, boxWidth / dpr, cellHeight / dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const image = ctx.getImageData(0, 0, scratchWidth, scratchHeight);
    return this.store(image, padX, padY);
  }

  /** The caller's drawer, built-in shapes (box drawing...), else the font. */
  private drawGlyphText(
    ctx: CanvasRenderingContext2D,
    text: string,
    codepoint: number,
    style: number,
    width: number,
    boxWidth: number,
    boxHeight: number
  ): void {
    const { drawGlyph, customGlyphs, devicePixelRatio: dpr, baseline } = this.config;
    if (drawGlyph) {
      const cell = this.cell;
      cell.codepoint = codepoint;
      cell.flags = (style & 1 ? CellFlags.BOLD : 0) | (style & 2 ? CellFlags.ITALIC : 0);
      cell.width = width;
      let codepoints = 0;
      for (const _ of text) codepoints++;
      cell.grapheme_len = Math.max(0, codepoints - 1);
      if (drawGlyph(ctx, cell, 0, 0, boxWidth, boxHeight, '#ffffff')) return;
    }
    const single = text.length === (codepoint > 0xffff ? 2 : 1);
    if (customGlyphs && single) {
      if (drawCustomGlyph(ctx, codepoint, 0, 0, boxWidth, boxHeight, '#ffffff', 1 / dpr)) return;
    }
    ctx.fillText(text, 0, baseline / dpr);
  }

  /** Copies the inked part of `image` to the texture. */
  private store(image: ImageData, padX: number, padY: number): Glyph {
    const { data, width } = image;
    const height = data.length / 4 / Math.max(1, width);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let colored = false;
    for (let y = 0; y < height; y++) {
      let i = y * width * 4;
      for (let x = 0; x < width; x++, i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
        // White text stays white (unpremultiplied, anti-aliased edges are
        // within rounding of it); a drawn color means a color glyph
        if (alpha > 32 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) {
          colored = true;
        }
      }
    }
    if (maxX < 0) return EMPTY;

    const glyphWidth = maxX - minX + 1;
    const glyphHeight = maxY - minY + 1;
    const place = this.allocate(glyphWidth, glyphHeight);
    if (!place) return EMPTY;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, minX);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, minY);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      place.x,
      place.y,
      glyphWidth,
      glyphHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    return {
      x: place.x,
      y: place.y,
      width: glyphWidth,
      height: glyphHeight,
      left: minX - padX,
      top: minY - padY,
      colored,
    };
  }

  /**
   * Space in the texture, growing it as needed. When it is full, the atlas
   * starts over (generation bumps): glyphs come back as they are asked for.
   */
  private allocate(width: number, height: number): { x: number; y: number } | null {
    let place = this.packer.allocate(width, height);
    if (!place) {
      // Never fits, even in an empty atlas: keep the glyphs it has
      if (width > this.packer.width || height > this.packer.maxHeight) return null;
      this.clear();
      place = this.packer.allocate(width, height);
      if (!place) return null;
    }
    if (this.packer.usedHeight > this.height) this.grow(this.packer.usedHeight);
    return place;
  }
}
