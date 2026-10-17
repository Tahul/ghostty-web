/**
 * Canvas Renderer for Terminal Display
 *
 * Canvas2D renderer that draws the terminal using Ghostty's WASM terminal
 * emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Box drawing, blocks, braille and Powerline symbols that fill their cell
 * - Dirty line optimization for 60 FPS
 *
 * WebGLRenderer (webgl/webgl-renderer.ts) extends it to draw with the GPU.
 */

import { drawCustomGlyph, isCustomGlyph } from './custom-glyphs';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  /** Row y without copies; the renderer reads one row at a time. Falls back to getLine. */
  getRowCells?(y: number): GhosttyCell[] | null;
  /**
   * Row y of what the viewport shows, scrolled or not, without copies. When
   * present, the renderer draws these rows and doesn't read the scrollback
   * itself; isRowDirty() then refers to viewport rows.
   */
  getViewportRowCells?(y: number): GhosttyCell[] | null;
  /**
   * The viewport as typed arrays, the cheapest way to read it (WebGLRenderer
   * uses it when present). Valid until the next update.
   */
  getViewportCellData?(): ViewportCellData;
  /** The grapheme cluster of viewport cell (x, y), with getViewportRowCells. */
  getViewportGrapheme?(y: number, x: number): string | null;
  /** Default background as 0xRRGGBB: cells holding it show the theme background. Defaults to 0. */
  getDefaultBackground?(): number;
  /**
   * The cursor. With viewportX/viewportY (-1 when off screen) it is drawn there,
   * else at (x, y) when the viewport is not scrolled.
   */
  getCursor(): {
    x: number;
    y: number;
    visible: boolean;
    viewportX?: number;
    viewportY?: number;
  };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

/**
 * The viewport as typed arrays, one entry per cell at index y * cols + x.
 * Colors are resolved 0xRRGGBB; `attrs` holds CellFlags in bits 0-7, and bit 8
 * is set inside an OSC 8 hyperlink.
 */
export interface ViewportCellData {
  readonly cols: number;
  readonly rows: number;
  readonly codepoints: Uint32Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  readonly attrs: Uint16Array;
  /** 1 normal, 2 wide, 0 the spacer after a wide character */
  readonly widths: Uint8Array;
  /** Codepoints beyond the first; the whole cluster is in `graphemes` */
  readonly graphemeExtra: Uint8Array;
  /** Grapheme clusters by cell index, for cells with graphemeExtra > 0 */
  readonly graphemes: ReadonlyMap<number, string>;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  /** A scrollback line without copies. Falls back to getScrollbackLine. */
  getScrollbackRowCells?(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  drawGlyph?: GlyphDrawer;
  /**
   * Draw box drawing, block elements, shades, braille and Powerline symbols
   * as shapes that fill their cell instead of with the font. Default: true.
   */
  customGlyphs?: boolean;
  /**
   * Ask for a low-latency canvas (`desynchronized`): frames can reach the
   * screen sooner, at the risk of tearing. Default: false.
   */
  lowLatency?: boolean;
}

/**
 * Draws a cell's glyph instead of the font (custom symbols, ...). Return true
 * when drawn, false to fall back to the built-in drawing. Called with the
 * cell's font, color and alpha already set; restore any other context state
 * you change. `x`/`y`/`width`/`height` are CSS pixels (the context is scaled
 * by the device pixel ratio). `cell` is reused: don't keep it.
 *
 * CanvasRenderer calls it for each non-blank cell it draws, except printable
 * ASCII drawn in runs. WebGLRenderer calls it once per glyph (codepoint or
 * cluster, bold/italic and cell width) and caches the result, drawn in white
 * and tinted per cell (glyphs drawn in other colors keep them): the drawing
 * must depend on nothing else.
 */
export type GlyphDrawer = (
  ctx: CanvasRenderingContext2D,
  cell: GhosttyCell,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
) => boolean;

/** Index into the per-style font caches: bit 0 bold, bit 1 italic. */
export function fontStyleIndex(flags: number): number {
  return (flags & CellFlags.BOLD ? 1 : 0) | (flags & CellFlags.ITALIC ? 2 : 0);
}

/** Flags that keep a cell out of a batched text run (they need per-cell work). */
const UNBATCHED_FLAGS = CellFlags.INVISIBLE | CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH;

/** Color strings stop being cached past this many (truecolor gradients). */
const MAX_CACHED_COLORS = 4096;

/** The underline of a hovered link. */
export const LINK_UNDERLINE_COLOR = '#4A90E2';

export type LinkRange = { startX: number; startY: number; endX: number; endY: number };

function sameLinkRange(a: LinkRange | null, b: LinkRange | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startX === b.startX && a.startY === b.startY && a.endX === b.endX && a.endY === b.endY;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/** What a frame draws, worked out by beginFrame(); rows to draw are in rowMarks. */
export interface FramePlan {
  cols: number;
  rows: number;
  viewportY: number;
  scrollbackLength: number;
  /** The viewport cell the cursor shows in, when cursorShown */
  cursorX: number;
  cursorY: number;
  /** Visible, on screen and in the visible blink phase */
  cursorShown: boolean;
  /** At another cell than last frame */
  cursorMoved: boolean;
  showScrollbar: boolean;
}

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

/** The scrollbar, in CSS pixels (see CanvasRenderer.scrollbarLayout). */
export interface ScrollbarLayout {
  /** The strip cleared over the cells at the right edge, full height */
  stripX: number;
  stripWidth: number;
  /** Track and thumb share x and width */
  x: number;
  width: number;
  trackY: number;
  trackHeight: number;
  thumbY: number;
  thumbHeight: number;
  /** Thumb alpha at full opacity: stronger when scrolled up */
  thumbAlpha: number;
}

export class CanvasRenderer {
  protected readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected fontSize: number;
  protected fontFamily: string;
  protected cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  protected theme: Required<ITheme>;
  protected readonly devicePixelRatio: number;
  protected metrics: FontMetrics;
  private palette: string[];
  /** Draw box drawing, blocks, braille and Powerline symbols as shapes (see RendererOptions) */
  protected readonly customGlyphs: boolean;

  // Cursor blinking state
  /** Whether the cursor is in the visible phase of its blink */
  protected cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  protected lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  /** Whether the cursor is on the canvas (drawn and not painted over since). */
  protected cursorDrawn: boolean = false;
  private cursorStyleChanged: boolean = false;

  /** Asks the owner for a frame (blink tick, hover, selection); see setRenderRequester. */
  private renderRequester?: () => void;
  protected readonly drawGlyph?: GlyphDrawer;

  /** Whether the last frame painted the scrollbar strip (over the cells under it). */
  protected scrollbarDrawn: boolean = false;
  /** Default background of the frame being drawn, as 0xRRGGBB. */
  protected defaultBg: number = 0;
  /** Rows to draw this frame (1 = draw), reused across frames. */
  protected rowMarks: Uint8Array = new Uint8Array(0);
  /** The frame being drawn (see beginFrame), reused across frames. */
  private readonly frame: FramePlan = {
    cols: 0,
    rows: 0,
    viewportY: 0,
    scrollbackLength: 0,
    cursorX: -1,
    cursorY: -1,
    cursorShown: false,
    cursorMoved: false,
    showScrollbar: false,
  };

  // Style strings, built once per font change / color, and what the context holds now
  protected fonts: string[] = ['', '', '', ''];
  /** Per font style: whether ASCII can be drawn in runs (monospaced, see measureFont). */
  private runnableFonts: boolean[] = [false, false, false, false];
  /** Per font style: letter spacing that makes a glyph advance exactly one cell ('' = none). */
  private runSpacing: string[] = ['', '', '', ''];
  /** Runs need ligatures and kerning off, which only `textRendering` gives canvas text. */
  private readonly canBatchText: boolean;
  private readonly canLetterSpace: boolean;
  private colorStrings = new Map<number, string>();
  private currentFont: string | null = null;
  private currentFill: string | null = null;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  protected hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: LinkRange | null = null;
  private previousHoveredLinkRange: LinkRange | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: options.lowLatency === true,
    });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.drawGlyph = options.drawGlyph;
    this.customGlyphs = options.customGlyphs ?? true;
    this.canBatchText = typeof (ctx as { textRendering?: unknown }).textRendering === 'string';
    this.canLetterSpace = typeof (ctx as { letterSpacing?: unknown }).letterSpacing === 'string';

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels; offset the baseline by half the padding
    const metrics = this.alignMetrics({
      width: Math.ceil(widthMetrics.width),
      height: Math.ceil(ascent + descent) + 2,
      baseline: Math.ceil(ascent) + 1,
    });

    // One font string per style, and whether that style can draw ASCII in runs
    for (let style = 0; style < 4; style++) {
      const italic = style & 2 ? 'italic ' : '';
      const bold = style & 1 ? 'bold ' : '';
      const font = `${italic}${bold}${this.fontSize}px ${this.fontFamily}`;
      this.fonts[style] = font;
      ctx.font = font;
      const advance = ctx.measureText('M').width;
      const spacing = metrics.width - advance;
      this.runSpacing[style] = spacing === 0 ? '' : `${spacing}px`;
      this.runnableFonts[style] =
        ctx.measureText(' ').width === advance && (spacing === 0 || this.canLetterSpace);
    }
    this.currentFont = null;

    return metrics;
  }

  /**
   * The cell size to use for a measured one: as measured here; WebGLRenderer
   * aligns it to device pixels. Runs during construction, before subclass
   * fields are initialized.
   */
  protected alignMetrics(metrics: FontMetrics): FontMetrics {
    return metrics;
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  /** `rgb(r, g, b)` for 0xRRGGBB, cached. */
  private colorString(rgb: number): string {
    let color = this.colorStrings.get(rgb);
    if (color === undefined) {
      if (this.colorStrings.size >= MAX_CACHED_COLORS) this.colorStrings.clear();
      color = `rgb(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff})`;
      this.colorStrings.set(rgb, color);
    }
    return color;
  }

  private setFont(font: string): void {
    if (font !== this.currentFont) {
      this.ctx.font = font;
      this.currentFont = font;
    }
  }

  private setFill(color: string): void {
    if (color !== this.currentFill) {
      this.ctx.fillStyle = color;
      this.currentFill = color;
    }
  }

  /** Forget what the context holds: after save/restore, a resize or foreign drawing. */
  protected resetStyleCache(): void {
    this.currentFont = null;
    this.currentFill = null;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = this.devicePixels(cssWidth);
    this.canvas.height = this.devicePixels(cssHeight);

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
    this.resetStyleCache();
    this.cursorDrawn = false;
    this.scrollbarDrawn = false;
  }

  /**
   * A CSS length in whole device pixels, as the canvas is sized. (Unrounded,
   * fractional pixel ratios left the canvas a fraction off its expected size,
   * so every frame resized it.)
   */
  protected devicePixels(css: number): number {
    return Math.round(css * this.devicePixelRatio);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas.
   *
   * Draws only what changed: dirty rows (with their neighbours, for glyphs
   * overflowing their row), selection and link-hover rows, and the cursor
   * when it moved, blinked or its row was redrawn. `forceAll` redraws every row.
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    const frame = this.beginFrame(
      buffer,
      forceAll,
      viewportY,
      scrollbackProvider,
      scrollbarOpacity
    );
    const marks = this.rowMarks;

    for (let y = 0; y < frame.rows; y++) {
      if (!marks[y]) continue;
      const line = this.fetchRow(buffer, y, viewportY, frame.scrollbackLength, scrollbackProvider);
      if (line) {
        this.renderLine(line, y, frame.cols);
      }
    }

    // Selection highlighting is integrated into the cell background/text passes,
    // and link underlines are drawn during cell rendering (see renderCellText)

    // Cursor: drawn when new, moved, or its row or a neighbour (overflowing
    // glyphs) was redrawn over it
    if (frame.cursorShown) {
      const y = frame.cursorY;
      const redrawn = marks[y] === 1 || marks[y - 1] === 1 || marks[y + 1] === 1;
      if (!this.cursorDrawn || frame.cursorMoved || redrawn) {
        this.renderCursor(frame.cursorX, y);
      }
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (frame.showScrollbar) {
      this.renderScrollbar(viewportY, frame.scrollbackLength, frame.rows, scrollbarOpacity);
    }

    this.endFrame(buffer);
  }

  /**
   * Works out what a frame draws. Marks the rows to draw in rowMarks: dirty
   * rows with their neighbours (glyphs overflow into adjacent rows), selection
   * and link-hover rows, the row the cursor leaves; every row when `forceAll`,
   * the canvas was resized or the viewport moved. Finds where the cursor shows.
   */
  protected beginFrame(
    buffer: IRenderable,
    forceAll: boolean,
    viewportY: number,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbarOpacity: number
  ): FramePlan {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;
    this.resetStyleCache();

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;
    this.defaultBg = buffer.getDefaultBackground?.() ?? 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== this.devicePixels(dims.cols * this.metrics.width) ||
      this.canvas.height !== this.devicePixels(dims.rows * this.metrics.height);

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // The scrollbar strip paints over cells: once it is gone, redraw what it covered
    const showScrollbar = !!scrollbackProvider && scrollbarOpacity > 0;
    if (this.scrollbarDrawn && !showScrollbar) {
      forceAll = true;
    }

    const rows = dims.rows;
    if (this.rowMarks.length !== rows) {
      this.rowMarks = new Uint8Array(rows);
    } else {
      this.rowMarks.fill(0);
    }
    const marks = this.rowMarks;

    // Where the cursor shows on screen, if it does
    const viewportRows = !!buffer.getViewportRowCells;
    const cursorX = cursor.viewportX ?? (viewportY === 0 ? cursor.x : -1);
    const cursorY = cursor.viewportY ?? (viewportY === 0 ? cursor.y : -1);

    // Erase the cursor where it was drawn when it moves, hides (blink) or changes shape
    const cursorShown = cursorY >= 0 && cursorX >= 0 && cursor.visible && this.cursorVisible;
    const last = this.lastCursorPosition;
    const cursorMoved = cursorX !== last.x || cursorY !== last.y;
    if (this.cursorDrawn && (cursorMoved || !cursorShown || this.cursorStyleChanged)) {
      if (last.y >= 0 && last.y < rows) this.markWithNeighbours(last.y);
    }
    this.cursorStyleChanged = false;

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        this.markWithNeighbours(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          this.markWithNeighbours(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Rows with the old or new hovered hyperlink (OSC 8)
    if (this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId) {
      for (let y = 0; y < rows; y++) {
        const line = this.fetchRow(buffer, y, viewportY, scrollbackLength, scrollbackProvider);
        if (!line) continue;
        for (const cell of line) {
          if (
            cell.hyperlink_id === this.hoveredHyperlinkId ||
            cell.hyperlink_id === this.previousHoveredHyperlinkId
          ) {
            this.markWithNeighbours(y);
            break; // Found hyperlink in this row
          }
        }
      }
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Rows of the old and new hovered regex link
    if (!sameLinkRange(this.hoveredLinkRange, this.previousHoveredLinkRange)) {
      for (const range of [this.previousHoveredLinkRange, this.hoveredLinkRange]) {
        if (!range) continue;
        for (let y = range.startY; y <= range.endY; y++) this.markWithNeighbours(y);
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Content: every row, or the dirty ones. Without viewport rows from the
    // buffer, screen row r shows at viewport row r + floor(viewportY) when
    // scrolled up, and scrollback rows only change with the viewport.
    if (forceAll) {
      marks.fill(1);
    } else {
      const offset = viewportY > 0 && !viewportRows ? Math.floor(viewportY) : 0;
      for (let y = offset; y < rows; y++) {
        if (buffer.isRowDirty(y - offset)) this.markWithNeighbours(y);
      }
    }

    const frame = this.frame;
    frame.cols = dims.cols;
    frame.rows = rows;
    frame.viewportY = viewportY;
    frame.scrollbackLength = scrollbackLength;
    frame.cursorX = cursorX;
    frame.cursorY = cursorY;
    frame.cursorShown = cursorShown;
    frame.cursorMoved = cursorMoved;
    frame.showScrollbar = showScrollbar;
    return frame;
  }

  /** Records what the frame (see beginFrame) put on the canvas, and marks the buffer drawn. */
  protected endFrame(buffer: IRenderable): void {
    const frame = this.frame;
    this.cursorDrawn = frame.cursorShown;
    this.scrollbarDrawn = frame.showScrollbar;
    this.lastCursorPosition.x = frame.cursorX;
    this.lastCursorPosition.y = frame.cursorY;

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /** Marks row y and its neighbours for this frame (glyphs overflow into adjacent rows). */
  private markWithNeighbours(y: number): void {
    const marks = this.rowMarks;
    if (y < 0 || y >= marks.length) return;
    marks[y] = 1;
    if (y > 0) marks[y - 1] = 1;
    if (y < marks.length - 1) marks[y + 1] = 1;
  }

  /**
   * The cells shown at viewport row y: from the scrollback when scrolled up
   * over it, else from the screen. Reused arrays: read one row at a time.
   */
  protected fetchRow(
    buffer: IRenderable,
    y: number,
    viewportY: number,
    scrollbackLength: number,
    scrollbackProvider?: IScrollbackProvider
  ): GhosttyCell[] | null {
    if (buffer.getViewportRowCells) return buffer.getViewportRowCells(y);
    if (viewportY > 0 && y < viewportY && scrollbackProvider) {
      // Floor viewportY for array access (handles fractional values during smooth scroll)
      const offset = scrollbackLength - Math.floor(viewportY) + y;
      return scrollbackProvider.getScrollbackRowCells
        ? scrollbackProvider.getScrollbackRowCells(offset)
        : scrollbackProvider.getScrollbackLine(offset);
    }
    const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
    return buffer.getRowCells ? buffer.getRowCells(screenRow) : buffer.getLine(screenRow);
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    // Snapped to device pixels: at fractional pixel ratios, two rows sharing a
    // pixel row would each clear it and cover it partly, leaving a translucent seam.
    const dpr = this.devicePixelRatio;
    const top = Math.round(lineY * dpr) / dpr;
    const bottom = Math.round((lineY + this.metrics.height) * dpr) / dpr;
    this.ctx.clearRect(0, top, lineWidth, bottom - top);
    this.setFill(this.theme.background);
    this.ctx.fillRect(0, top, lineWidth, bottom - top);

    // PASS 1: Draw all cell backgrounds first, one fillRect per run of one color
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    let runColor: string | null = null;
    let runStart = 0;
    let runEnd = 0;
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      const color = this.cellBackground(cell, x, y);
      if (color !== runColor || x !== runEnd) {
        if (runColor !== null) this.fillCells(runColor, runStart, runEnd, lineY);
        runColor = color;
        runStart = x;
      }
      runEnd = x + cell.width;
    }
    if (runColor !== null) this.fillCells(runColor, runStart, runEnd, lineY);

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; ) {
      const cell = line[x];
      if (cell.width === 0) {
        x++; // Skip spacer cells for wide characters
        continue;
      }
      if (this.isRunnable(cell, x, y)) {
        x = this.renderTextRun(line, x, y);
        continue;
      }
      if (!this.isBlank(cell) || this.mayDecorate(cell)) {
        this.renderCellText(cell, x, y);
      }
      x++;
    }
  }

  private fillCells(color: string, start: number, end: number, lineY: number): void {
    this.setFill(color);
    const width = this.metrics.width;
    this.ctx.fillRect(start * width, lineY, (end - start) * width, this.metrics.height);
  }

  /**
   * A cell's background color, or null where the row's theme fill shows (cells
   * holding the default background). Selection replaces the cell background,
   * which avoids z-order issues with glyphs extending outside their cell.
   */
  private cellBackground(cell: GhosttyCell, x: number, y: number): string | null {
    if (this.isInSelection(x, y)) {
      return this.theme.selectionBackground;
    }
    // When inverted, background becomes foreground
    const rgb =
      cell.flags & CellFlags.INVERSE
        ? (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b
        : (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
    return rgb === this.defaultBg ? null : this.colorString(rgb);
  }

  /** The text color of a cell: selection foreground, or its (inverse-aware) foreground. */
  private cellForeground(cell: GhosttyCell, x: number, y: number): string {
    if (this.isInSelection(x, y)) {
      return this.theme.selectionForeground;
    }
    // When inverted, foreground becomes background
    const rgb =
      cell.flags & CellFlags.INVERSE
        ? (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b
        : (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
    return this.colorString(rgb);
  }

  /** A space (or empty cell): nothing to fill, only decorations to draw. */
  private isBlank(cell: GhosttyCell): boolean {
    return cell.grapheme_len === 0 && (cell.codepoint === 0 || cell.codepoint === 32);
  }

  /** Whether a cell can carry a line (underline, strikethrough, link underline). */
  private mayDecorate(cell: GhosttyCell): boolean {
    return (
      (cell.flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH)) !== 0 ||
      cell.hyperlink_id > 0 ||
      this.hoveredLinkRange !== null
    );
  }

  /**
   * Printable ASCII without decorations, in a font whose glyphs advance exactly
   * one cell: such cells can be drawn as one string per run of one style.
   */
  private isRunnable(cell: GhosttyCell, x: number, y: number): boolean {
    const codepoint = cell.codepoint;
    return (
      this.canBatchText &&
      codepoint > 0x20 &&
      codepoint < 0x7f &&
      cell.grapheme_len === 0 &&
      cell.width === 1 &&
      (cell.flags & UNBATCHED_FLAGS) === 0 &&
      cell.hyperlink_id === 0 &&
      this.runnableFonts[fontStyleIndex(cell.flags)] &&
      !this.isInHoveredLinkRange(x, y)
    );
  }

  /**
   * Draws the run of runnable cells starting at `start` that share flags and
   * color with one fillText (blank cells inside a run become spaces).
   * Returns the column after the run.
   */
  private renderTextRun(line: GhosttyCell[], start: number, y: number): number {
    const first = line[start];
    const flags = first.flags;
    const color = this.cellForeground(first, start, y);
    let text = String.fromCharCode(first.codepoint);
    let spaces = '';
    let x = start + 1;
    for (; x < line.length; x++) {
      const cell = line[x];
      if (this.isBlank(cell) && cell.width === 1 && !this.mayDecorate(cell)) {
        spaces += ' ';
        continue;
      }
      if (
        cell.flags !== flags ||
        !this.isRunnable(cell, x, y) ||
        this.cellForeground(cell, x, y) !== color
      ) {
        break;
      }
      text += spaces + String.fromCharCode(cell.codepoint);
      spaces = '';
    }

    const ctx = this.ctx as CanvasRenderingContext2D & { textRendering: string };
    this.setFont(this.fonts[fontStyleIndex(flags)]);
    this.setFill(color);
    if (flags & CellFlags.FAINT) ctx.globalAlpha = 0.5;
    // Cells are drawn one glyph each: no ligatures nor kerning across them
    const textRendering = ctx.textRendering;
    ctx.textRendering = 'optimizeSpeed';
    const spacing = this.runSpacing[fontStyleIndex(flags)];
    if (spacing) (ctx as { letterSpacing: string }).letterSpacing = spacing;
    ctx.fillText(text, start * this.metrics.width, y * this.metrics.height + this.metrics.baseline);
    if (spacing) (ctx as { letterSpacing: string }).letterSpacing = '0px';
    ctx.textRendering = textRendering;
    if (flags & CellFlags.FAINT) ctx.globalAlpha = 1.0;
    return x;
  }

  /** Whether viewport cell (x, y) is in the hovered plain-text link. */
  protected isInHoveredLinkRange(x: number, y: number): boolean {
    const range = this.hoveredLinkRange;
    if (!range) return false;
    return (
      (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
      (y > range.startY && y < range.endY) ||
      (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
    );
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Set text style and color - use override, selection foreground, or normal color
    this.setFont(this.fonts[fontStyleIndex(cell.flags)]);
    const color = colorOverride ?? this.cellForeground(cell, x, y);
    this.setFill(color);

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text (blank cells have none): the caller's drawer, then built-in
    // shapes (box drawing...), then the font
    if (!this.isBlank(cell)) {
      let drawn = false;
      if (this.drawGlyph) {
        // The drawer may leave font, fill or alpha changed: restore them
        this.ctx.save();
        drawn =
          this.drawGlyph(this.ctx, cell, cellX, cellY, cellWidth, this.metrics.height, color) ===
          true;
        this.ctx.restore();
      }
      if (!drawn && this.customGlyphs && cell.grapheme_len === 0) {
        drawn = drawCustomGlyph(
          this.ctx,
          cell.codepoint,
          cellX,
          cellY,
          cellWidth,
          this.metrics.height,
          color,
          1 / this.devicePixelRatio
        );
      }
      if (!drawn) {
        // Get the character to render - use grapheme lookup for complex scripts
        let char: string;
        const buffer = this.currentBuffer;
        if (cell.grapheme_len > 0 && buffer?.getViewportGrapheme) {
          // Cell has additional codepoints - get full grapheme cluster
          char = buffer.getViewportGrapheme(y, x) ?? String.fromCodePoint(cell.codepoint);
        } else if (cell.grapheme_len > 0 && buffer?.getGraphemeString) {
          char = buffer.getGraphemeString(y, x);
        } else {
          // Simple cell - single codepoint
          char = String.fromCodePoint(cell.codepoint);
        }
        this.ctx.fillText(char, cellX, cellY + this.metrics.baseline);
      }
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks), only when hovered (cleaner look)
    if (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) {
      this.drawLinkUnderline(cellX, cellY, cellWidth);
    }

    // Draw regex link underline (for plain text URLs)
    if (this.isInHoveredLinkRange(x, y)) {
      this.drawLinkUnderline(cellX, cellY, cellWidth);
    }
  }

  private drawLinkUnderline(cellX: number, cellY: number, cellWidth: number): void {
    const underlineY = cellY + this.metrics.baseline + 2;
    this.ctx.strokeStyle = LINK_UNDERLINE_COLOR; // Blue underline on hover
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(cellX, underlineY);
    this.ctx.lineTo(cellX + cellWidth, underlineY);
    this.ctx.stroke();
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.setFill(this.theme.cursor);

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const buffer = this.currentBuffer;
          const line = buffer?.getViewportRowCells
            ? buffer.getViewportRowCells(y)
            : buffer?.getRowCells
              ? buffer.getRowCells(y)
              : buffer?.getLine(y);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
            this.resetStyleCache();
          }
        }
        break;

      case 'underline': {
        // Underline at bottom of cell
        const underlineHeight = this.cursorThickness('underline');
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;
      }

      case 'bar':
        // Vertical bar at left of cell
        this.ctx.fillRect(cursorX, cursorY, this.cursorThickness('bar'), this.metrics.height);
        break;
    }
  }

  /** Thickness of the underline and bar cursors, in CSS pixels. */
  protected cursorThickness(style: 'underline' | 'bar'): number {
    const size = style === 'underline' ? this.metrics.height : this.metrics.width;
    return Math.max(2, Math.floor(size * 0.15));
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.requestRender();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Who to ask for a frame when the renderer's own state changes (cursor
   * blink, link hover, selection): the terminal's render loop.
   */
  public setRenderRequester(requester: (() => void) | undefined): void {
    this.renderRequester = requester;
  }

  /** Asks for a frame; render() then draws whatever changed. */
  public requestRender(): void {
    this.renderRequester?.();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    if (style === this.cursorStyle) return;
    this.cursorStyle = style;
    this.cursorStyleChanged = true;
    this.requestRender();
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
      this.requestRender(); // the cursor may be in its hidden phase
    }
  }

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const bar = this.scrollbarLayout(viewportY, scrollbackLength, visibleRows);
    const canvasHeight = this.canvas.height / this.devicePixelRatio;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(bar.stripX, 0, bar.stripWidth, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(bar.stripX, 0, bar.stripWidth, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(bar.x, bar.trackY, bar.width, bar.trackHeight);

    // Draw scrollbar thumb with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${bar.thumbAlpha * opacity})`;
    ctx.fillRect(bar.x, bar.thumbY, bar.width, bar.thumbHeight);
  }

  /**
   * Where the scrollbar goes, in CSS pixels: an 8px track 4px from the right
   * and vertical edges, its thumb sized and placed by the scroll position.
   */
  protected scrollbarLayout(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number
  ): ScrollbarLayout {
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = scrollbackLength > 0 ? viewportY / scrollbackLength : 0; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    return {
      stripX: scrollbarX - 2,
      stripWidth: scrollbarWidth + 6,
      x: scrollbarX,
      width: scrollbarWidth,
      trackY: scrollbarPadding,
      trackHeight: scrollbarTrackHeight,
      thumbY,
      thumbHeight,
      thumbAlpha: viewportY > 0 ? 0.5 : 0.3,
    };
  }

  /**
   * Get current font metrics
   */
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  protected isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    if (hyperlinkId === this.hoveredHyperlinkId) return;
    this.hoveredHyperlinkId = hyperlinkId;
    this.requestRender();
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(range: LinkRange | null): void {
    if (sameLinkRange(range, this.hoveredLinkRange)) return;
    this.hoveredLinkRange = range;
    this.requestRender();
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.resetStyleCache();
    this.cursorDrawn = false;
    this.scrollbarDrawn = false;
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}
