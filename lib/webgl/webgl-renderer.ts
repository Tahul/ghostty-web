/**
 * WebGL2 renderer: the terminal drawn by the GPU.
 *
 * Cells are instanced quads. Backgrounds come from a texture holding one texel
 * per cell, glyphs from a shared atlas (see GlyphAtlas), decorations and the
 * cursor are solid rectangles. Only rows that changed are rebuilt and
 * uploaded. A frame is drawn on the page's shared WebGL canvas (see GLDevice)
 * and the rows that changed are copied onto this renderer's canvas.
 *
 * A WebGLRenderer is a CanvasRenderer: without WebGL2, or while its context
 * is lost, it draws with Canvas2D, and it returns to the GPU when it can.
 */

import { CellAttr } from '../ghostty';
import type { ITheme } from '../interfaces';
import {
  CanvasRenderer,
  type FontMetrics,
  type FramePlan,
  type IRenderable,
  type IScrollbackProvider,
  LINK_UNDERLINE_COLOR,
  type RendererOptions,
  type ViewportCellData,
  fontStyleIndex,
} from '../renderer';
import { CellFlags, type GhosttyCell } from '../types';
import {
  type RGBA,
  overPremultiplied,
  packColor,
  packPremultiplied,
  packRgb,
  parseCssColor,
} from './color';
import { CORNER_LOCATION, GLDevice, type GLDeviceListener } from './gl-device';
import { GlyphAtlas, type GlyphAtlasConfig } from './glyph-atlas';

/**
 * Glyph instance, 5 words: position (2 x i16), size (2 x u16), atlas
 * position (2 x u16), straight color (4 x u8), colored flag (u8).
 */
const GLYPH_WORDS = 5;
const GLYPH_STRIDE = GLYPH_WORDS * 4;
/** Rectangle instance, 3 words: position (2 x i16), size (2 x u16), premultiplied color (4 x u8). */
const RECT_WORDS = 3;
const RECT_STRIDE = RECT_WORDS * 4;
/** Rectangles kept per row before packing: x, y, width, height, color. */
const RECT_FIELDS = 5;

/** Per-cell bits, to draw a cell again under a block cursor. */
const CELL_UNDERLINE = 1;
const CELL_STRIKE = 2;
const CELL_LINK = 4;
const CELL_FAINT = 8;

/** The cell arrays a row is built from: the viewport's, or one row converted. */
type CellSource = Pick<
  ViewportCellData,
  'codepoints' | 'fg' | 'bg' | 'attrs' | 'widths' | 'graphemeExtra' | 'graphemes'
>;

/** Theme colors, packed for the GPU. */
interface ThemeColors {
  /** What cells with the default background show (premultiplied) */
  background: number;
  /** Selected cells, drawn over the background (premultiplied) */
  selectionBackground: number;
  /** Selected text, full and half (faint) strength (straight) */
  selectionForeground: number;
  selectionForegroundFaint: number;
  /** Lines under or through selected text (premultiplied) */
  selectionLine: number;
  cursor: number;
  cursorAccent: RGBA;
  link: number;
}

/** What one renderer keeps on the GPU. */
interface GpuResources {
  corners: WebGLBuffer;
  glyphs: WebGLBuffer;
  glyphVao: WebGLVertexArrayObject;
  cursorGlyph: WebGLBuffer;
  cursorGlyphVao: WebGLVertexArrayObject;
  rects: WebGLBuffer;
  rectVao: WebGLVertexArrayObject;
  /** For the background pass, which has no attributes */
  emptyVao: WebGLVertexArrayObject;
  /** One texel per cell: its background, premultiplied */
  backgrounds: WebGLTexture | null;
}

export class WebGLRenderer extends CanvasRenderer {
  private device: GLDevice | null = null;
  private gpu: GpuResources | null = null;
  private atlas: GlyphAtlas | null = null;
  private atlasKey = '';
  private atlasGeneration = -1;
  /** Rebuild and repaint every row in the next GPU frame */
  private rebuildAll = true;
  /** The last frame was drawn with the GPU: switching repaints everything */
  private drewWithGpu = false;
  private colors: ThemeColors = resolveThemeColors(this.theme);

  // The cells as the GPU draws them
  private gridCols = 0;
  private gridRows = 0;
  private glyphData = new Uint32Array(0);
  private backgroundData = new Uint32Array(0);
  private backgroundBytes = new Uint8Array(0);
  private cellBits = new Uint8Array(0);
  private rowRects: number[][] = [];
  /** The frame's rectangles as RECT_FIELDS numbers each, then packed in frameRects */
  private readonly frameRectFields: number[] = [];
  private frameRects = new Uint32Array(64 * RECT_WORDS);
  private readonly cursorGlyph = new Uint32Array(GLYPH_WORDS);
  private readonly scratchRow = new ScratchRow();

  // Line geometry in device pixels, from the cell top (see layoutLines)
  private lineThickness = 1;
  private underlineTop = 0;
  private strikeTop = 0;

  private readonly deviceListener: GLDeviceListener = {
    contextLost: () => {
      // Everything on the GPU is gone: draw with Canvas2D until it is back
      this.gpu = null;
      this.requestRender();
    },
    contextRestored: () => {
      this.gpu = null;
      this.rebuildAll = true;
      this.requestRender();
    },
  };

  /** Glyphs drawn before a web font loaded used a fallback font: draw them again. */
  private readonly handleFontsLoaded = (): void => {
    this.atlas?.reset();
    this.requestRender();
  };

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    super(canvas, options);
    this.device = GLDevice.acquire(this.deviceListener);
    if (this.device) document.fonts?.addEventListener('loadingdone', this.handleFontsLoaded);
  }

  /**
   * Whether the last frame was drawn with WebGL2: false without WebGL2 or
   * while its context is lost (frames are drawn with Canvas2D then).
   */
  public get usesGpu(): boolean {
    return this.drewWithGpu;
  }

  /** Cells of whole device pixels, so glyph quads and box drawing land exactly on them. */
  protected override alignMetrics(metrics: FontMetrics): FontMetrics {
    const dpr = this.devicePixelRatio;
    const align = (css: number) => Math.max(1, Math.round(css * dpr)) / dpr;
    return {
      width: align(metrics.width),
      height: align(metrics.height),
      baseline: Math.round(metrics.baseline * dpr) / dpr,
    };
  }

  public override setTheme(theme: ITheme): void {
    super.setTheme(theme);
    this.colors = resolveThemeColors(this.theme);
    this.rebuildAll = true;
  }

  public override resize(cols: number, rows: number): void {
    super.resize(cols, rows);
    this.rebuildAll = true;
  }

  public override clear(): void {
    super.clear();
    this.rebuildAll = true;
  }

  public override dispose(): void {
    super.dispose();
    document.fonts?.removeEventListener('loadingdone', this.handleFontsLoaded);
    const device = this.device;
    if (!device) return;
    if (this.gpu && device.usable) deleteGpuResources(device.gl, this.gpu);
    this.gpu = null;
    if (this.atlas) device.releaseShared(this.atlasKey);
    this.atlas = null;
    device.release(this.deviceListener);
    this.device = null;
  }

  public override render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    const device = this.device;
    const { cols, rows } = buffer.getDimensions();
    if (
      !device ||
      !device.usable ||
      !device.fit(cols * this.cellWidth, rows * this.cellHeight) ||
      !this.prepareGpu(device.gl)
    ) {
      // Canvas2D: everything once after GPU frames, then what changed
      super.render(
        buffer,
        forceAll || this.drewWithGpu,
        viewportY,
        scrollbackProvider,
        scrollbarOpacity
      );
      this.drewWithGpu = false;
      return;
    }
    const frame = this.beginFrame(
      buffer,
      forceAll || !this.drewWithGpu,
      viewportY,
      scrollbackProvider,
      scrollbarOpacity
    );
    this.drewWithGpu = true;
    if (!this.renderWithGpu(device, buffer, frame, scrollbackProvider, scrollbarOpacity)) {
      // The screen's glyphs don't fit the atlas at once: Canvas2D for this frame
      this.rebuildAll = true;
      super.render(buffer, true, viewportY, scrollbackProvider, scrollbarOpacity);
      this.drewWithGpu = false;
      return;
    }
    this.endFrame(buffer);
  }

  // ==========================================================================
  // Frame
  // ==========================================================================

  /** Draws the frame; false when the atlas started over twice while rows were built. */
  private renderWithGpu(
    device: GLDevice,
    buffer: IRenderable,
    frame: FramePlan,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbarOpacity: number
  ): boolean {
    const gl = device.gl;
    const gpu = this.gpu!;
    const { cols, rows } = frame;
    if (cols !== this.gridCols || rows !== this.gridRows) this.allocateGrid(gl, gpu, cols, rows);
    const atlas = this.syncAtlas(device);
    this.layoutLines();

    const marks = this.rowMarks;
    if (this.rebuildAll) {
      marks.fill(1);
      this.rebuildAll = false;
    }
    // The cursor shows in its cell once it appears or moves there
    const cursorY = frame.cursorY;
    if (frame.cursorShown && (!this.cursorDrawn || frame.cursorMoved) && cursorY < rows) {
      marks[cursorY] = 1;
    }

    const generation = atlas.generation;
    this.buildRows(buffer, frame, scrollbackProvider);
    if (atlas.generation !== generation) {
      // The atlas started over while rows were built: earlier positions are stale
      marks.fill(1);
      const rebuiltGeneration = atlas.generation;
      this.buildRows(buffer, frame, scrollbackProvider);
      // Started over again: rows built before point at replaced glyphs
      if (atlas.generation !== rebuiltGeneration) return false;
    }
    this.atlasGeneration = atlas.generation;
    this.uploadRows(gl, gpu);

    // The scrollbar strip runs down the whole height
    if (frame.showScrollbar) marks.fill(1);
    const first = marks.indexOf(1);
    if (first < 0) return true;
    this.drawFrame(device, gpu, atlas, frame, first, marks.lastIndexOf(1) + 1, scrollbarOpacity);
    this.present(device.canvas, frame);
    return true;
  }

  /** Creates this renderer's GPU resources if needed; false when that fails. */
  private prepareGpu(gl: WebGL2RenderingContext): boolean {
    if (this.gpu) return true;
    this.gpu = createGpuResources(gl);
    // A new grid on the new resources, filled in full
    this.gridCols = 0;
    this.gridRows = 0;
    this.rebuildAll = true;
    return this.gpu !== null;
  }

  private allocateGrid(
    gl: WebGL2RenderingContext,
    gpu: GpuResources,
    cols: number,
    rows: number
  ): void {
    const cells = cols * rows;
    this.gridCols = cols;
    this.gridRows = rows;
    this.glyphData = new Uint32Array(cells * GLYPH_WORDS);
    this.backgroundData = new Uint32Array(cells);
    this.backgroundBytes = new Uint8Array(this.backgroundData.buffer);
    this.cellBits = new Uint8Array(cells);
    this.rowRects = Array.from({ length: rows }, () => []);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.glyphs);
    gl.bufferData(gl.ARRAY_BUFFER, this.glyphData.byteLength, gl.DYNAMIC_DRAW);
    if (gpu.backgrounds) gl.deleteTexture(gpu.backgrounds);
    gpu.backgrounds = createTexture(gl, cols, rows);
    this.rebuildAll = true;
  }

  /** The atlas for the current font, shared with renderers drawing the same glyphs. */
  private syncAtlas(device: GLDevice): GlyphAtlas {
    const dpr = this.devicePixelRatio;
    const config: GlyphAtlasConfig = {
      fonts: [...this.fonts],
      devicePixelRatio: dpr,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      baseline: Math.round(this.metrics.baseline * dpr),
      customGlyphs: this.customGlyphs,
      drawGlyph: this.drawGlyph,
    };
    const key = GlyphAtlas.key(config);
    if (!this.atlas || key !== this.atlasKey) {
      if (this.atlas) device.releaseShared(this.atlasKey);
      this.atlas = device.acquireShared(key, () => new GlyphAtlas(device.gl, config));
      this.atlasKey = key;
      this.rebuildAll = true;
    }
    if (this.atlas.generation !== this.atlasGeneration) this.rebuildAll = true;
    return this.atlas;
  }

  private get cellWidth(): number {
    return Math.round(this.metrics.width * this.devicePixelRatio);
  }

  private get cellHeight(): number {
    return Math.round(this.metrics.height * this.devicePixelRatio);
  }

  /** Underlines and strikethroughs where the canvas renderer strokes them, on whole pixels. */
  private layoutLines(): void {
    const dpr = this.devicePixelRatio;
    const height = this.cellHeight;
    const thickness = Math.max(1, Math.round(dpr));
    const clamp = (top: number) => Math.max(0, Math.min(height - thickness, top));
    this.lineThickness = thickness;
    this.underlineTop = clamp(Math.round((this.metrics.baseline + 2) * dpr - thickness / 2));
    this.strikeTop = clamp(Math.round(height / 2 - thickness / 2));
  }

  // ==========================================================================
  // Rows
  // ==========================================================================

  /** Rebuilds the marked rows from the buffer. */
  private buildRows(
    buffer: IRenderable,
    frame: FramePlan,
    scrollbackProvider: IScrollbackProvider | undefined
  ): void {
    const marks = this.rowMarks;
    const data = buffer.getViewportCellData?.();
    const direct = data && data.cols === frame.cols && data.rows === frame.rows ? data : null;
    for (let y = 0; y < frame.rows; y++) {
      if (!marks[y]) continue;
      if (direct) {
        this.buildRow(y, direct, y * frame.cols);
        continue;
      }
      const line = this.fetchRow(
        buffer,
        y,
        frame.viewportY,
        frame.scrollbackLength,
        scrollbackProvider
      );
      this.scratchRow.load(line, frame.cols, this.defaultBg, buffer, y);
      this.buildRow(y, this.scratchRow, 0);
    }
  }

  /**
   * Row y's glyph instances, background texels and decorations, from the
   * cells at `base` in `data`. Colors follow the canvas renderer: inverse
   * swaps them, selection replaces them, default backgrounds show the theme's.
   */
  private buildRow(y: number, data: CellSource, base: number): void {
    const cols = this.gridCols;
    const W = this.cellWidth;
    const top = y * this.cellHeight;
    const atlas = this.atlas!;
    const colors = this.colors;
    const glyphs = this.glyphData;
    const backgrounds = this.backgroundData;
    const bits = this.cellBits;
    const rects = this.rowRects[y];
    rects.length = 0;
    const defaultBg = this.defaultBg;
    const hoveredLink = this.hoveredHyperlinkId;

    for (let x = 0; x < cols; x++) {
      const i = base + x;
      const cell = y * cols + x;
      const g = cell * GLYPH_WORDS;
      const width = data.widths[i];
      bits[cell] = 0;
      if (width === 0) {
        // The spacer after a wide character shows its background, nothing else
        backgrounds[cell] = x > 0 ? backgrounds[cell - 1] : colors.background;
        glyphs[g + 1] = 0;
        continue;
      }

      const attrs = data.attrs[i];
      const flags = attrs & 0xff;
      const selected = this.isInSelection(x, y);
      const inverse = (flags & CellFlags.INVERSE) !== 0;
      const fg = inverse ? data.bg[i] : data.fg[i];
      const bg = inverse ? data.fg[i] : data.bg[i];
      const faint = (flags & CellFlags.FAINT) !== 0;

      backgrounds[cell] = selected
        ? colors.selectionBackground
        : bg === defaultBg
          ? colors.background
          : packRgb(bg);

      const invisible = (flags & CellFlags.INVISIBLE) !== 0;
      const codepoint = data.codepoints[i];
      const extra = data.graphemeExtra[i];
      if (invisible || (extra === 0 && (codepoint === 0 || codepoint === 32))) {
        glyphs[g + 1] = 0;
      } else {
        const style = fontStyleIndex(flags);
        const glyph =
          extra > 0
            ? atlas.getText(data.graphemes.get(i) ?? String.fromCodePoint(codepoint), style, width)
            : atlas.getCodepoint(codepoint, style, width);
        if (glyph.width === 0) {
          glyphs[g + 1] = 0;
        } else {
          glyphs[g] = packPoint(x * W + glyph.left, top + glyph.top);
          glyphs[g + 1] = (glyph.width | (glyph.height << 16)) >>> 0;
          glyphs[g + 2] = (glyph.x | (glyph.y << 16)) >>> 0;
          glyphs[g + 3] = selected
            ? faint
              ? colors.selectionForegroundFaint
              : colors.selectionForeground
            : packColor((fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff, faint ? 128 : 255);
          glyphs[g + 4] = glyph.colored ? 1 : 0;
        }
      }
      if (invisible) continue;

      let cellBits = faint ? CELL_FAINT : 0;
      if (flags & CellFlags.UNDERLINE) cellBits |= CELL_UNDERLINE;
      if (flags & CellFlags.STRIKETHROUGH) cellBits |= CELL_STRIKE;
      const linkId = attrs & CellAttr.HYPERLINK ? 1 : 0;
      if ((linkId > 0 && linkId === hoveredLink) || this.isInHoveredLinkRange(x, y)) {
        cellBits |= CELL_LINK;
      }
      bits[cell] = cellBits;
      if (cellBits & ~CELL_FAINT) {
        const line = selected ? colors.selectionLine : packRgb(fg);
        this.addLines(rects, cellBits, x * W, top, width * W, line);
      }
    }
  }

  /** The underline, strikethrough and link underline a cell has. */
  private addLines(
    rects: number[],
    cellBits: number,
    x: number,
    top: number,
    width: number,
    color: number
  ): void {
    const thickness = this.lineThickness;
    if (cellBits & CELL_UNDERLINE) {
      addLine(rects, x, top + this.underlineTop, width, thickness, color);
    }
    if (cellBits & CELL_STRIKE) {
      addLine(rects, x, top + this.strikeTop, width, thickness, color);
    }
    if (cellBits & CELL_LINK) {
      addLine(rects, x, top + this.underlineTop, width, thickness, this.colors.link);
    }
  }

  /** Uploads the marked rows' glyph instances and background texels. */
  private uploadRows(gl: WebGL2RenderingContext, gpu: GpuResources): void {
    const marks = this.rowMarks;
    const cols = this.gridCols;
    const rows = this.gridRows;
    const words = cols * GLYPH_WORDS;
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.glyphs);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.backgrounds);
    for (let y = 0; y < rows; ) {
      if (!marks[y]) {
        y++;
        continue;
      }
      let end = y + 1;
      while (end < rows && marks[end]) end++;
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        y * words * 4,
        this.glyphData,
        y * words,
        (end - y) * words
      );
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y,
        cols,
        end - y,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.backgroundBytes,
        y * cols * 4
      );
      y = end;
    }
  }

  // ==========================================================================
  // Drawing
  // ==========================================================================

  /**
   * Draws rows [first, end) on the shared canvas: backgrounds, glyphs, lines,
   * the cursor and the scrollbar. The frame sits at the canvas's top-left.
   */
  private drawFrame(
    device: GLDevice,
    gpu: GpuResources,
    atlas: GlyphAtlas,
    frame: FramePlan,
    first: number,
    end: number,
    scrollbarOpacity: number
  ): void {
    const gl = device.gl;
    const { background, glyph, rect } = device.programs;
    const W = this.cellWidth;
    const H = this.cellHeight;
    const width = frame.cols * W;
    const height = frame.rows * H;
    const bottom = gl.drawingBufferHeight - height;
    gl.viewport(0, bottom, width, height);
    gl.enable(gl.SCISSOR_TEST);
    const scissorBottom = bottom + height - end * H;
    gl.scissor(0, scissorBottom, width, (end - first) * H);

    // Backgrounds replace whatever the shared canvas held
    gl.disable(gl.BLEND);
    gl.useProgram(background.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gpu.backgrounds);
    gl.uniform1i(background.uniforms.u_cells, 0);
    gl.uniform3f(background.uniforms.u_frame, 0, bottom, height);
    gl.uniform2f(background.uniforms.u_cellSize, W, H);
    gl.bindVertexArray(gpu.emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Glyphs, then lines and the cursor, blended (premultiplied colors)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(glyph.program);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.uniform1i(glyph.uniforms.u_atlas, 0);
    gl.uniform2f(glyph.uniforms.u_resolution, width, height);
    gl.bindVertexArray(gpu.glyphVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, frame.cols * frame.rows);

    const segments = this.collectRects(frame, scrollbarOpacity);
    if (segments.total > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.rects);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.frameRects,
        gl.DYNAMIC_DRAW,
        0,
        segments.total * RECT_WORDS
      );
    }
    gl.useProgram(rect.program);
    gl.uniform2f(rect.uniforms.u_resolution, width, height);
    drawRects(gl, gpu, 0, segments.lines);

    // Under a block cursor, the cell's glyph and lines again in the accent color
    if (segments.cursorCell) {
      const cellTop = frame.cursorY * H;
      const top = Math.max(cellTop, first * H);
      const bottomEdge = Math.min(cellTop + H, end * H);
      if (bottomEdge > top) {
        gl.scissor(frame.cursorX * W, bottom + height - bottomEdge, W, bottomEdge - top);
        if (this.cursorGlyph[1] !== 0) {
          gl.useProgram(glyph.program);
          gl.bindBuffer(gl.ARRAY_BUFFER, gpu.cursorGlyph);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cursorGlyph);
          gl.bindVertexArray(gpu.cursorGlyphVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
          gl.useProgram(rect.program);
        }
        drawRects(gl, gpu, segments.lines, segments.cursorLines);
        gl.scissor(0, scissorBottom, width, (end - first) * H);
      }
    }

    // The scrollbar's strip replaces the cells under it; track and thumb blend
    if (segments.strip) {
      const start = segments.lines + segments.cursorLines;
      gl.disable(gl.BLEND);
      drawRects(gl, gpu, start, 1);
      gl.enable(gl.BLEND);
      drawRects(gl, gpu, start + 1, segments.total - start - 1);
    }

    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  /**
   * Fills frameRects: every row's lines and the cursor, the cursor cell's
   * lines in the accent color, then the scrollbar (strip, track, thumb).
   * Also prepares the glyph drawn under a block cursor.
   */
  private collectRects(
    frame: FramePlan,
    scrollbarOpacity: number
  ): { lines: number; cursorLines: number; strip: boolean; total: number; cursorCell: boolean } {
    const W = this.cellWidth;
    const H = this.cellHeight;
    const dpr = this.devicePixelRatio;
    const colors = this.colors;
    const out = this.frameRectFields;
    out.length = 0;

    for (const rects of this.rowRects) {
      for (let r = 0; r < rects.length; r++) out.push(rects[r]);
    }

    let cursorCell = false;
    const cursorLines: number[] = [];
    if (frame.cursorShown && frame.cursorY < frame.rows && frame.cursorX < frame.cols) {
      const x = frame.cursorX * W;
      const y = frame.cursorY * H;
      if (this.cursorStyle === 'block') {
        addRect(out, x, y, W, H, colors.cursor);
        cursorCell = true;
        this.prepareCursorCell(frame, x, y, cursorLines);
      } else if (this.cursorStyle === 'underline') {
        const thickness = Math.round(this.cursorThickness('underline') * dpr);
        addRect(out, x, y + H - thickness, W, thickness, colors.cursor);
      } else {
        addRect(out, x, y, Math.round(this.cursorThickness('bar') * dpr), H, colors.cursor);
      }
    }
    const lines = out.length / RECT_FIELDS;
    for (const value of cursorLines) out.push(value);

    let strip = false;
    if (frame.showScrollbar) {
      strip = true;
      const bar = this.scrollbarLayout(frame.viewportY, frame.scrollbackLength, frame.rows);
      const px = (css: number) => Math.round(css * dpr);
      const height = frame.rows * H;
      const stripX = px(bar.stripX);
      addRect(out, stripX, 0, px(bar.stripX + bar.stripWidth) - stripX, height, colors.background);
      if (scrollbarOpacity > 0 && frame.scrollbackLength > 0) {
        const barWidth = px(bar.x + bar.width) - px(bar.x);
        const gray = [128, 128, 128, 1] as const;
        const trackY = px(bar.trackY);
        const thumbY = px(bar.thumbY);
        const trackColor = packPremultiplied(gray, 0.1 * scrollbarOpacity);
        const thumbColor = packPremultiplied(gray, bar.thumbAlpha * scrollbarOpacity);
        addRect(
          out,
          px(bar.x),
          trackY,
          barWidth,
          px(bar.trackY + bar.trackHeight) - trackY,
          trackColor
        );
        addRect(
          out,
          px(bar.x),
          thumbY,
          barWidth,
          px(bar.thumbY + bar.thumbHeight) - thumbY,
          thumbColor
        );
      }
    }

    const total = out.length / RECT_FIELDS;
    if (this.frameRects.length < total * RECT_WORDS) {
      this.frameRects = new Uint32Array(
        Math.max(total, (this.frameRects.length / RECT_WORDS) * 2) * RECT_WORDS
      );
    }
    const words = this.frameRects;
    for (let r = 0, w = 0; r < out.length; r += RECT_FIELDS, w += RECT_WORDS) {
      words[w] = packPoint(out[r], out[r + 1]);
      words[w + 1] = (out[r + 2] | (out[r + 3] << 16)) >>> 0;
      words[w + 2] = out[r + 4];
    }
    return { lines, cursorLines: cursorLines.length / RECT_FIELDS, strip, total, cursorCell };
  }

  /** The block cursor cell's glyph (cursorGlyph) and lines, in the accent color. */
  private prepareCursorCell(frame: FramePlan, x: number, y: number, lines: number[]): void {
    const cell = frame.cursorY * this.gridCols + frame.cursorX;
    const bits = this.cellBits[cell];
    const accent = this.colors.cursorAccent;
    const g = cell * GLYPH_WORDS;
    for (let w = 0; w < GLYPH_WORDS; w++) this.cursorGlyph[w] = this.glyphData[g + w];
    const alpha = Math.round(accent[3] * (bits & CELL_FAINT ? 127.5 : 255));
    this.cursorGlyph[3] = packColor(accent[0], accent[1], accent[2], alpha);
    if (bits & ~CELL_FAINT) {
      this.addLines(lines, bits, x, y, this.cellWidth, packPremultiplied(accent));
    }
  }

  /** Copies the marked rows from the shared canvas onto this renderer's. */
  private present(source: HTMLCanvasElement, frame: FramePlan): void {
    const ctx = this.ctx;
    const marks = this.rowMarks;
    const H = this.cellHeight;
    const width = frame.cols * this.cellWidth;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let y = 0; y < frame.rows; ) {
      if (!marks[y]) {
        y++;
        continue;
      }
      let end = y + 1;
      while (end < frame.rows && marks[end]) end++;
      const top = y * H;
      const height = (end - y) * H;
      // Replace, not blend: translucent backgrounds would pile up
      ctx.clearRect(0, top, width, height);
      ctx.drawImage(source, 0, top, width, height, 0, top, width, height);
      y = end;
    }
    ctx.restore();
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Two signed 16-bit values in one word (x low). */
function packPoint(x: number, y: number): number {
  return ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
}

/** Adds a rectangle (x, y, width, height, color) to `rects`. */
function addRect(
  rects: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: number
): void {
  if (width > 0 && height > 0) rects.push(x, y, width, height, color);
}

/** Adds a line, or extends the same line of the cell before when it continues it. */
function addLine(
  rects: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: number
): void {
  // A cell adds at most three lines: the one it continues is among the last three
  const stop = Math.max(0, rects.length - 3 * RECT_FIELDS);
  for (let r = rects.length - RECT_FIELDS; r >= stop; r -= RECT_FIELDS) {
    if (
      rects[r + 1] === y &&
      rects[r + 3] === height &&
      rects[r + 4] === color &&
      rects[r] + rects[r + 2] === x
    ) {
      rects[r + 2] += width;
      return;
    }
  }
  addRect(rects, x, y, width, height, color);
}

/** Draws `count` rectangles from instance `first` of the rect buffer. */
function drawRects(
  gl: WebGL2RenderingContext,
  gpu: GpuResources,
  first: number,
  count: number
): void {
  if (count <= 0) return;
  gl.bindVertexArray(gpu.rectVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.rects);
  rectAttributes(gl, first * RECT_STRIDE);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
}

function resolveThemeColors(theme: Required<ITheme>): ThemeColors {
  const background = packPremultiplied(parseCssColor(theme.background));
  const selectionForeground = parseCssColor(theme.selectionForeground);
  const [r, g, b, a] = selectionForeground;
  return {
    background,
    selectionBackground: overPremultiplied(
      packPremultiplied(parseCssColor(theme.selectionBackground)),
      background
    ),
    selectionForeground: packColor(r, g, b, Math.round(a * 255)),
    selectionForegroundFaint: packColor(r, g, b, Math.round(a * 127.5)),
    selectionLine: packPremultiplied(selectionForeground),
    cursor: packPremultiplied(parseCssColor(theme.cursor)),
    cursorAccent: parseCssColor(theme.cursorAccent),
    link: packPremultiplied(parseCssColor(LINK_UNDERLINE_COLOR)),
  };
}

function createGpuResources(gl: WebGL2RenderingContext): GpuResources | null {
  const corners = gl.createBuffer();
  const glyphs = gl.createBuffer();
  const cursorGlyph = gl.createBuffer();
  const rects = gl.createBuffer();
  const glyphVao = gl.createVertexArray();
  const cursorGlyphVao = gl.createVertexArray();
  const rectVao = gl.createVertexArray();
  const emptyVao = gl.createVertexArray();
  if (!corners || !glyphs || !cursorGlyph || !rects) return null;
  if (!glyphVao || !cursorGlyphVao || !rectVao || !emptyVao) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

  for (const [vao, buffer] of [
    [glyphVao, glyphs],
    [cursorGlyphVao, cursorGlyph],
  ] as const) {
    gl.bindVertexArray(vao);
    cornerAttribute(gl, corners);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    glyphAttributes(gl);
  }
  // The glyph under a block cursor: one instance
  gl.bindBuffer(gl.ARRAY_BUFFER, cursorGlyph);
  gl.bufferData(gl.ARRAY_BUFFER, GLYPH_STRIDE, gl.DYNAMIC_DRAW);

  gl.bindVertexArray(rectVao);
  cornerAttribute(gl, corners);
  gl.bindBuffer(gl.ARRAY_BUFFER, rects);
  rectAttributes(gl, 0);
  gl.bindVertexArray(null);

  return {
    corners,
    glyphs,
    glyphVao,
    cursorGlyph,
    cursorGlyphVao,
    rects,
    rectVao,
    emptyVao,
    backgrounds: null,
  };
}

function deleteGpuResources(gl: WebGL2RenderingContext, gpu: GpuResources): void {
  for (const buffer of [gpu.corners, gpu.glyphs, gpu.cursorGlyph, gpu.rects])
    gl.deleteBuffer(buffer);
  for (const vao of [gpu.glyphVao, gpu.cursorGlyphVao, gpu.rectVao, gpu.emptyVao]) {
    gl.deleteVertexArray(vao);
  }
  if (gpu.backgrounds) gl.deleteTexture(gpu.backgrounds);
}

/** The per-vertex quad corner (bound to the VAO being set up). */
function cornerAttribute(gl: WebGL2RenderingContext, corners: WebGLBuffer): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.enableVertexAttribArray(CORNER_LOCATION);
  gl.vertexAttribPointer(CORNER_LOCATION, 2, gl.UNSIGNED_BYTE, false, 0, 0);
}

/** Glyph instance attributes from the bound buffer (see GLYPH_WORDS). */
function glyphAttributes(gl: WebGL2RenderingContext): void {
  instanceAttribute(gl, 0, 2, gl.SHORT, false, GLYPH_STRIDE, 0);
  instanceAttribute(gl, 1, 2, gl.UNSIGNED_SHORT, false, GLYPH_STRIDE, 4);
  instanceAttribute(gl, 2, 2, gl.UNSIGNED_SHORT, false, GLYPH_STRIDE, 8);
  instanceAttribute(gl, 3, 4, gl.UNSIGNED_BYTE, true, GLYPH_STRIDE, 12);
  instanceAttribute(gl, 4, 1, gl.UNSIGNED_BYTE, false, GLYPH_STRIDE, 16);
}

/** Rectangle instance attributes from the bound buffer, starting `offset` bytes in. */
function rectAttributes(gl: WebGL2RenderingContext, offset: number): void {
  instanceAttribute(gl, 0, 2, gl.SHORT, false, RECT_STRIDE, offset);
  instanceAttribute(gl, 1, 2, gl.UNSIGNED_SHORT, false, RECT_STRIDE, offset + 4);
  instanceAttribute(gl, 2, 4, gl.UNSIGNED_BYTE, true, RECT_STRIDE, offset + 8);
}

function instanceAttribute(
  gl: WebGL2RenderingContext,
  location: number,
  size: number,
  type: number,
  normalized: boolean,
  stride: number,
  offset: number
): void {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
  gl.vertexAttribDivisor(location, 1);
}

/** An RGBA8 texture of `width` x `height` texels, sampled exactly (texelFetch). */
function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number
): WebGLTexture | null {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

/**
 * One row of GhosttyCell objects in the typed layout, for buffers that can't
 * hand out the viewport's arrays (getViewportCellData).
 */
class ScratchRow implements CellSource {
  codepoints = new Uint32Array(0);
  fg = new Uint32Array(0);
  bg = new Uint32Array(0);
  attrs = new Uint16Array(0);
  widths = new Uint8Array(0);
  graphemeExtra = new Uint8Array(0);
  readonly graphemes = new Map<number, string>();

  /** Loads row y (`line`, cells beyond it blank in the default background). */
  load(
    line: GhosttyCell[] | null,
    cols: number,
    defaultBg: number,
    buffer: IRenderable,
    y: number
  ): void {
    if (this.codepoints.length !== cols) {
      this.codepoints = new Uint32Array(cols);
      this.fg = new Uint32Array(cols);
      this.bg = new Uint32Array(cols);
      this.attrs = new Uint16Array(cols);
      this.widths = new Uint8Array(cols);
      this.graphemeExtra = new Uint8Array(cols);
    }
    this.graphemes.clear();
    for (let x = 0; x < cols; x++) {
      const cell = line?.[x];
      if (!cell) {
        this.codepoints[x] = 0;
        this.fg[x] = 0;
        this.bg[x] = defaultBg;
        this.attrs[x] = 0;
        this.widths[x] = 1;
        this.graphemeExtra[x] = 0;
        continue;
      }
      this.codepoints[x] = cell.codepoint;
      this.fg[x] = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
      this.bg[x] = (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
      this.attrs[x] = cell.flags | (cell.hyperlink_id > 0 ? CellAttr.HYPERLINK : 0);
      this.widths[x] = cell.width;
      this.graphemeExtra[x] = Math.min(255, cell.grapheme_len);
      if (cell.grapheme_len > 0) {
        const cluster = buffer.getViewportGrapheme
          ? buffer.getViewportGrapheme(y, x)
          : (buffer.getGraphemeString?.(y, x) ?? null);
        this.graphemes.set(x, cluster ?? String.fromCodePoint(cell.codepoint));
      }
    }
  }
}
