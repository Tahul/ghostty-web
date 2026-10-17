/**
 * TypeScript bindings for libghostty-vt, Ghostty's terminal core compiled to
 * WebAssembly.
 *
 * GhosttyTerminal keeps a JS copy of the screen it shows: each update reads
 * the rows the render state marks dirty, one bulk call per row, into typed
 * arrays. Renderers then never cross the wasm boundary per cell. Rows off
 * screen (scrollback), hyperlink URIs and grapheme clusters are read on demand
 * through grid references.
 */

import { type BitField, TypeManifest, readBits } from './ghostty-abi';
import type { ViewportCellData } from './renderer';
import {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
} from './types';
import { FunctionTable } from './wasm-callbacks';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

/**
 * How long a program may hold the screen with synchronized output (mode 2026)
 * before it is shown anyway, so a program that never releases it can't freeze
 * the screen.
 */
export const RENDER_HOLD_TIMEOUT_MS = 1000;

/**
 * Cell attribute bits above CellFlags in the viewport attribute array.
 * @internal
 */
export const CellAttr = {
  HYPERLINK: 1 << 8,
  OVERLINE: 1 << 9,
  /** Underline style (GhosttySgrUnderline: 1 single, 2 double, 3 curly, 4 dotted, 5 dashed) */
  UNDERLINE_SHIFT: 10,
  UNDERLINE_MASK: 0x7 << 10,
} as const;

/** DEC mode 2027: grapheme clustering, so emoji sequences and combining marks share a cell. */
const MODE_GRAPHEME_CLUSTER = 2027;
/** DEC mode 2026: synchronized output. */
const MODE_SYNC_OUTPUT = 2026;
/** GhosttyMode: bit 15 marks an ANSI mode, bits 0-14 hold the mode number. */
const MODE_ANSI_BIT = 0x8000;

/** Default colors when the configuration names none (ghostty-web's historical defaults). */
const DEFAULT_FOREGROUND = 0xcccccc;
const DEFAULT_BACKGROUND = 0x000000;

/** Device attributes reported to DA1/DA2/DA3 queries: a VT220 with ANSI color. */
const DA1_CONFORMANCE_LEVEL = 62;
const DA1_FEATURES = [22];
const DA2 = { deviceType: 1, firmwareVersion: 10, romCartridge: 0 };

/** Codepoints a grapheme cluster read can hold before it needs a bigger buffer. */
const GRAPHEME_BUFFER_CODEPOINTS = 32;

// ============================================================================
// Memory helpers
// ============================================================================

/**
 * Typed views of wasm memory. An export that allocates may grow the memory,
 * which detaches the old buffer, so call refresh() before reading after one.
 */
class WasmMemory {
  private buffer: ArrayBuffer | null = null;
  u8!: Uint8Array;
  u16!: Uint16Array;
  u32!: Uint32Array;
  i32!: Int32Array;
  view!: DataView;

  constructor(private readonly memory: WebAssembly.Memory) {
    this.refresh();
  }

  refresh(): this {
    const buffer = this.memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.u8 = new Uint8Array(buffer);
      this.u16 = new Uint16Array(buffer);
      this.u32 = new Uint32Array(buffer);
      this.i32 = new Int32Array(buffer);
      this.view = new DataView(buffer);
    }
    return this;
  }
}

/** One wasm allocation carved into the fixed-size slots a terminal passes to exports. */
class Scratch {
  readonly base: number;
  private used = 0;

  constructor(
    private readonly exports: GhosttyWasmExports,
    private readonly size: number
  ) {
    this.base = exports.ghostty_wasm_alloc(size) >>> 0;
    if (!this.base) throw new Error('Failed to allocate wasm scratch memory');
  }

  reserve(bytes: number, align: number = 8): number {
    this.used = Math.ceil(this.used / align) * align;
    const ptr = this.base + this.used;
    this.used += bytes;
    if (this.used > this.size) throw new Error('wasm scratch memory exhausted');
    return ptr;
  }

  free(): void {
    this.exports.ghostty_wasm_free(this.base, this.size);
  }
}

// ============================================================================
// ABI layout
// ============================================================================

/** The struct offsets, enum values and bit positions the bindings use. */
function buildLayout(m: TypeManifest) {
  const e = (type: string, name: string) => m.enumValue(type, name);
  const o = (type: string, field: string) => m.offset(type, field);
  const cell = 'GhosttyCell';
  const styleColor = (field: string) => ({
    tag: o('GhosttyStyle', field) + o('GhosttyStyleColor', 'tag'),
    value: o('GhosttyStyle', field) + o('GhosttyStyleColor', 'value'),
  });
  return {
    result: {
      SUCCESS: e('GhosttyResult', 'SUCCESS'),
      OUT_OF_SPACE: e('GhosttyResult', 'OUT_OF_SPACE'),
    },
    opt: {
      WRITE_PTY: e('GhosttyTerminalOption', 'WRITE_PTY'),
      BELL: e('GhosttyTerminalOption', 'BELL'),
      TITLE_CHANGED: e('GhosttyTerminalOption', 'TITLE_CHANGED'),
      SIZE: e('GhosttyTerminalOption', 'SIZE'),
      COLOR_SCHEME: e('GhosttyTerminalOption', 'COLOR_SCHEME'),
      DEVICE_ATTRIBUTES: e('GhosttyTerminalOption', 'DEVICE_ATTRIBUTES'),
      COLOR_FOREGROUND: e('GhosttyTerminalOption', 'COLOR_FOREGROUND'),
      COLOR_BACKGROUND: e('GhosttyTerminalOption', 'COLOR_BACKGROUND'),
      COLOR_CURSOR: e('GhosttyTerminalOption', 'COLOR_CURSOR'),
      COLOR_PALETTE: e('GhosttyTerminalOption', 'COLOR_PALETTE'),
      DEFAULT_CURSOR_STYLE: e('GhosttyTerminalOption', 'DEFAULT_CURSOR_STYLE'),
      DEFAULT_CURSOR_BLINK: e('GhosttyTerminalOption', 'DEFAULT_CURSOR_BLINK'),
      SCROLLBACK_MAX_BYTES: e('GhosttyTerminalOption', 'SCROLLBACK_MAX_BYTES'),
      SCROLLBACK_MAX_LINES: e('GhosttyTerminalOption', 'SCROLLBACK_MAX_LINES'),
      MODE_DEFAULT: e('GhosttyTerminalOption', 'MODE_DEFAULT'),
      MODE: e('GhosttyTerminalOption', 'MODE'),
      RENDER_HOLD: e('GhosttyTerminalOption', 'RENDER_HOLD'),
    },
    data: {
      CURSOR_X: e('GhosttyTerminalData', 'CURSOR_X'),
      CURSOR_Y: e('GhosttyTerminalData', 'CURSOR_Y'),
      ACTIVE_SCREEN: e('GhosttyTerminalData', 'ACTIVE_SCREEN'),
      MOUSE_TRACKING: e('GhosttyTerminalData', 'MOUSE_TRACKING'),
      TITLE: e('GhosttyTerminalData', 'TITLE'),
      SCROLLBACK_ROWS: e('GhosttyTerminalData', 'SCROLLBACK_ROWS'),
      MODE: e('GhosttyTerminalData', 'MODE'),
      COLOR_BACKGROUND: e('GhosttyTerminalData', 'COLOR_BACKGROUND'),
      COLOR_PALETTE_DEFAULT: e('GhosttyTerminalData', 'COLOR_PALETTE_DEFAULT'),
    },
    screenAlternate: e('GhosttyTerminalScreen', 'ALTERNATE'),
    cursorStyle: {
      bar: e('GhosttyTerminalCursorStyle', 'BAR'),
      block: e('GhosttyTerminalCursorStyle', 'BLOCK'),
      underline: e('GhosttyTerminalCursorStyle', 'UNDERLINE'),
    },
    visualStyle: {
      [e('GhosttyRenderStateCursorVisualStyle', 'BAR')]: 'bar',
      [e('GhosttyRenderStateCursorVisualStyle', 'BLOCK')]: 'block',
      [e('GhosttyRenderStateCursorVisualStyle', 'UNDERLINE')]: 'underline',
      [e('GhosttyRenderStateCursorVisualStyle', 'BLOCK_HOLLOW')]: 'block_hollow',
    } as Record<number, RenderStateCursor['style']>,
    colorScheme: {
      LIGHT: e('GhosttyColorScheme', 'LIGHT'),
      DARK: e('GhosttyColorScheme', 'DARK'),
    },
    scroll: {
      size: m.size('GhosttyTerminalScrollViewport'),
      tag: o('GhosttyTerminalScrollViewport', 'tag'),
      value: o('GhosttyTerminalScrollViewport', 'value'),
      BOTTOM: e('GhosttyTerminalScrollViewportTag', 'BOTTOM'),
      ROW: e('GhosttyTerminalScrollViewportTag', 'ROW'),
    },
    point: {
      size: m.size('GhosttyPoint'),
      tag: o('GhosttyPoint', 'tag'),
      x: o('GhosttyPoint', 'value') + o('GhosttyPointCoordinate', 'x'),
      y: o('GhosttyPoint', 'value') + o('GhosttyPointCoordinate', 'y'),
      ACTIVE: e('GhosttyPointTag', 'ACTIVE'),
      HISTORY: e('GhosttyPointTag', 'HISTORY'),
    },
    gridRef: {
      size: m.size('GhosttyGridRef'),
      sizeField: o('GhosttyGridRef', 'size'),
      x: o('GhosttyGridRef', 'x'),
    },
    mode: {
      size: m.size('GhosttyTerminalModeConfig'),
      mode: o('GhosttyTerminalModeConfig', 'mode'),
      value: o('GhosttyTerminalModeConfig', 'value'),
    },
    string: {
      size: m.size('GhosttyString'),
      ptr: o('GhosttyString', 'ptr'),
      len: o('GhosttyString', 'len'),
    },
    cellsView: {
      size: m.size('GhosttyCellsView'),
      ptr: o('GhosttyCellsView', 'ptr'),
      len: o('GhosttyCellsView', 'len'),
    },
    rs: {
      DIRTY: e('GhosttyRenderStateData', 'DIRTY'),
      ROW_ITERATOR: e('GhosttyRenderStateData', 'ROW_ITERATOR'),
      COLORS: e('GhosttyRenderStateData', 'COLORS'),
      CURSOR: e('GhosttyRenderStateData', 'CURSOR'),
      dirtyFalse: e('GhosttyRenderStateDirty', 'FALSE'),
      dirtyFull: e('GhosttyRenderStateDirty', 'FULL'),
    },
    row: {
      RAW: e('GhosttyRenderStateRowData', 'RAW'),
      CELLS: e('GhosttyRenderStateRowData', 'CELLS'),
      CELLS_RAW: e('GhosttyRenderStateRowData', 'CELLS_RAW'),
      /** The row continues the previous one (xterm.js `isWrapped`) */
      WRAP_CONTINUATION: e('GhosttyRowData', 'WRAP_CONTINUATION'),
    },
    rowCells: {
      STYLE: e('GhosttyRenderStateRowCellsData', 'STYLE'),
      GRAPHEMES_LEN: e('GhosttyRenderStateRowCellsData', 'GRAPHEMES_LEN'),
      GRAPHEMES_BUF: e('GhosttyRenderStateRowCellsData', 'GRAPHEMES_BUF'),
    },
    colors: {
      size: m.size('GhosttyRenderStateColors'),
      sizeField: o('GhosttyRenderStateColors', 'size'),
      background: o('GhosttyRenderStateColors', 'background'),
      foreground: o('GhosttyRenderStateColors', 'foreground'),
      cursor: o('GhosttyRenderStateColors', 'cursor'),
      cursorHasValue: o('GhosttyRenderStateColors', 'cursor_has_value'),
      palette: o('GhosttyRenderStateColors', 'palette'),
    },
    cursor: {
      size: m.size('GhosttyRenderStateCursor'),
      sizeField: o('GhosttyRenderStateCursor', 'size'),
      viewportHasValue: o('GhosttyRenderStateCursor', 'viewport_has_value'),
      viewportX: o('GhosttyRenderStateCursor', 'viewport_x'),
      viewportY: o('GhosttyRenderStateCursor', 'viewport_y'),
      visible: o('GhosttyRenderStateCursor', 'visible'),
      blinking: o('GhosttyRenderStateCursor', 'blinking'),
      visualStyle: o('GhosttyRenderStateCursor', 'visual_style'),
    },
    style: {
      size: m.size('GhosttyStyle'),
      sizeField: o('GhosttyStyle', 'size'),
      fg: styleColor('fg_color'),
      bg: styleColor('bg_color'),
      bold: o('GhosttyStyle', 'bold'),
      italic: o('GhosttyStyle', 'italic'),
      faint: o('GhosttyStyle', 'faint'),
      blink: o('GhosttyStyle', 'blink'),
      inverse: o('GhosttyStyle', 'inverse'),
      invisible: o('GhosttyStyle', 'invisible'),
      strikethrough: o('GhosttyStyle', 'strikethrough'),
      overline: o('GhosttyStyle', 'overline'),
      underline: o('GhosttyStyle', 'underline'),
      PALETTE: e('GhosttyStyleColorTag', 'PALETTE'),
      RGB: e('GhosttyStyleColorTag', 'RGB'),
      rgb: {
        r: o('GhosttyColorRgb', 'r'),
        g: o('GhosttyColorRgb', 'g'),
        b: o('GhosttyColorRgb', 'b'),
      },
    },
    cell: {
      tag: m.bits(cell, 'content_tag'),
      codepoint: m.armBits(cell, 'content', 'CODEPOINT', 'codepoint'),
      paletteIndex: m.armBits(cell, 'content', 'BG_COLOR_PALETTE', 'index'),
      bgR: m.armBits(cell, 'content', 'BG_COLOR_RGB', 'r'),
      bgG: m.armBits(cell, 'content', 'BG_COLOR_RGB', 'g'),
      bgB: m.armBits(cell, 'content', 'BG_COLOR_RGB', 'b'),
      styleId: m.bits(cell, 'style_id'),
      wide: m.bits(cell, 'wide'),
      hyperlink: m.bits(cell, 'hyperlink'),
      CODEPOINT_GRAPHEME: e('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
      BG_COLOR_PALETTE: e('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
      BG_COLOR_RGB: e('GhosttyCellContentTag', 'BG_COLOR_RGB'),
      WIDE: e('GhosttyCellWide', 'WIDE'),
      SPACER_TAIL: e('GhosttyCellWide', 'SPACER_TAIL'),
      SPACER_HEAD: e('GhosttyCellWide', 'SPACER_HEAD'),
    },
    da: {
      conformance:
        o('GhosttyDeviceAttributes', 'primary') +
        o('GhosttyDeviceAttributesPrimary', 'conformance_level'),
      features:
        o('GhosttyDeviceAttributes', 'primary') + o('GhosttyDeviceAttributesPrimary', 'features'),
      numFeatures:
        o('GhosttyDeviceAttributes', 'primary') +
        o('GhosttyDeviceAttributesPrimary', 'num_features'),
      deviceType:
        o('GhosttyDeviceAttributes', 'secondary') +
        o('GhosttyDeviceAttributesSecondary', 'device_type'),
      firmwareVersion:
        o('GhosttyDeviceAttributes', 'secondary') +
        o('GhosttyDeviceAttributesSecondary', 'firmware_version'),
      romCartridge:
        o('GhosttyDeviceAttributes', 'secondary') +
        o('GhosttyDeviceAttributesSecondary', 'rom_cartridge'),
      unitId:
        o('GhosttyDeviceAttributes', 'tertiary') + o('GhosttyDeviceAttributesTertiary', 'unit_id'),
    },
    sizeReport: {
      rows: o('GhosttySizeReportSize', 'rows'),
      columns: o('GhosttySizeReportSize', 'columns'),
      cellWidth: o('GhosttySizeReportSize', 'cell_width'),
      cellHeight: o('GhosttySizeReportSize', 'cell_height'),
    },
  };
}

type Layout = ReturnType<typeof buildLayout>;

/** Function pointers of the effect callbacks, shared by every terminal of a module. */
interface Effects {
  writePty: number;
  bell: number;
  titleChanged: number;
  renderHold: number;
  deviceAttributes: number;
  size: number;
  colorScheme: number;
}

function check(result: number, layout: Layout, what: string): void {
  if (result !== layout.result.SUCCESS) throw new Error(`${what} failed (GhosttyResult ${result})`);
}

/** Takes the handle an export wrote into a slot from ghostty_wasm_alloc_opaque(). */
function newHandle(
  exports: GhosttyWasmExports,
  layout: Layout,
  what: string,
  create: (slot: number) => number
): number {
  const slot = exports.ghostty_wasm_alloc_opaque() >>> 0;
  try {
    check(create(slot), layout, what);
    return exports.ghostty_wasm_take_opaque(slot) >>> 0;
  } finally {
    exports.ghostty_wasm_free_opaque(slot);
  }
}

// ============================================================================
// Ghostty
// ============================================================================

/**
 * A loaded libghostty-vt module. Terminals and key encoders made from it share
 * its memory.
 */
export class Ghostty {
  /** @internal */
  readonly exports: GhosttyWasmExports;
  /** @internal */
  readonly memory: WebAssembly.Memory;
  /** @internal */
  readonly mem: WasmMemory;
  /** The libghostty-vt struct layouts this module was built with. */
  readonly manifest: TypeManifest;
  /** @internal */
  readonly layout: Layout;
  /** @internal */
  readonly effects: Effects;
  /** Terminals by handle, for the effect callbacks. */
  private readonly terminals = new Map<number, GhosttyTerminal>();

  constructor(wasmInstance: WebAssembly.Instance) {
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
    this.mem = new WasmMemory(this.memory);
    this.manifest = TypeManifest.read(this.exports.ghostty_type_json, this.memory);
    this.layout = buildLayout(this.manifest);
    this.effects = this.installEffects();
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new GhosttyTerminal(this, cols, rows, config);
  }

  /** @internal */
  register(terminal: GhosttyTerminal): void {
    this.terminals.set(terminal.handle, terminal);
  }

  /** @internal */
  unregister(terminal: GhosttyTerminal): void {
    this.terminals.delete(terminal.handle);
  }

  /** The callbacks every terminal installs; they route by terminal handle. */
  private installEffects(): Effects {
    const table = new FunctionTable(this.exports.__indirect_function_table);
    const term = (handle: number) => this.terminals.get(handle >>> 0);
    const bool = (value: boolean | undefined) => (value ? 1 : 0);
    return {
      writePty: table.add(
        (t: number, _ud: number, data: number, len: number) =>
          term(t)?.onWritePty(data >>> 0, len >>> 0),
        ['i32', 'i32', 'i32', 'i32']
      ),
      bell: table.add((t: number) => term(t)?.onBell(), ['i32', 'i32']),
      titleChanged: table.add((t: number) => term(t)?.onTitleChanged(), ['i32', 'i32']),
      renderHold: table.add(
        (t: number, _ud: number, held: number) => term(t)?.onRenderHold(held !== 0),
        ['i32', 'i32', 'i32']
      ),
      deviceAttributes: table.add(
        (t: number, _ud: number, out: number) => bool(term(t)?.onDeviceAttributes(out >>> 0)),
        ['i32', 'i32', 'i32'],
        'i32'
      ),
      size: table.add(
        (t: number, _ud: number, out: number) => bool(term(t)?.onSizeReport(out >>> 0)),
        ['i32', 'i32', 'i32'],
        'i32'
      ),
      colorScheme: table.add(
        (t: number, _ud: number, out: number) => bool(term(t)?.onColorScheme(out >>> 0)),
        ['i32', 'i32', 'i32'],
        'i32'
      ),
    };
  }

  static async load(wasmPath?: string): Promise<Ghostty> {
    // If explicit path provided, use it
    if (wasmPath) {
      return Ghostty.loadFromPath(wasmPath);
    }

    // Resolve path relative to this module
    const moduleUrl = new URL('../ghostty-vt.wasm', import.meta.url);

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first (strip file:// protocol)
    if (moduleUrl.protocol === 'file:') {
      let filePath = moduleUrl.pathname;
      // Remove leading slash on Windows paths (e.g., /C:/ -> C:/)
      if (filePath.match(/^\/[A-Za-z]:\//)) {
        filePath = filePath.slice(1);
      }
      defaultPaths.push(filePath);
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work
    if (!wasmBytes) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    return new Ghostty(wasmInstance);
  }
}

// ============================================================================
// Key encoder
// ============================================================================

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private readonly exports: GhosttyWasmExports;
  private readonly mem: WasmMemory;
  private readonly layout: Layout;
  private encoder: number;
  private event: number;
  private readonly scratch: Scratch;
  private readonly valuePtr: number;
  private readonly outLenPtr: number;
  private readonly utf8Ptr: number;
  private static readonly UTF8_CAPACITY = 128;
  private outPtr = 0;
  private outCapacity = 0;
  private static readonly textEncoder = new TextEncoder();

  constructor(ghostty: Ghostty) {
    this.exports = ghostty.exports;
    this.mem = ghostty.mem;
    this.layout = ghostty.layout;
    const ex = this.exports;
    this.encoder = newHandle(ex, this.layout, 'ghostty_key_encoder_new', (slot) =>
      ex.ghostty_key_encoder_new(0, slot)
    );
    this.event = newHandle(ex, this.layout, 'ghostty_key_event_new', (slot) =>
      ex.ghostty_key_event_new(0, slot)
    );
    this.scratch = new Scratch(ex, 256);
    this.valuePtr = this.scratch.reserve(8);
    this.outLenPtr = this.scratch.reserve(4, 4);
    this.utf8Ptr = this.scratch.reserve(KeyEncoder.UTF8_CAPACITY, 1);
    this.growOutput(64);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const mem = this.mem.refresh();
    const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    // MACOS_OPTION_AS_ALT is an enum (i32); the others are bool or u8
    if (option === KeyEncoderOption.MACOS_OPTION_AS_ALT) {
      mem.view.setInt32(this.valuePtr, numeric, true);
    } else {
      mem.u8[this.valuePtr] = numeric;
    }
    this.exports.ghostty_key_encoder_setopt(this.encoder, option, this.valuePtr);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  /**
   * Sets the options the terminal's state decides: cursor and keypad
   * application modes, Kitty keyboard flags, Alt and Backspace behavior.
   */
  syncFromTerminal(terminal: GhosttyTerminal): void {
    this.exports.ghostty_key_encoder_setopt_from_terminal(this.encoder, terminal.handle);
  }

  encode(event: KeyEvent): Uint8Array {
    const ex = this.exports;
    const ev = this.event;
    ex.ghostty_key_event_set_action(ev, event.action);
    ex.ghostty_key_event_set_key(ev, event.key);
    ex.ghostty_key_event_set_mods(ev, event.mods);
    ex.ghostty_key_event_set_consumed_mods(ev, event.consumedMods ?? 0);
    ex.ghostty_key_event_set_composing(ev, event.composing ? 1 : 0);
    ex.ghostty_key_event_set_unshifted_codepoint(ev, event.unshiftedCodepoint ?? 0);

    // The event keeps a pointer to the text until encode() returns
    let textPtr = this.utf8Ptr;
    let textLen = 0;
    let ownedText = 0;
    if (event.utf8) {
      const bytes = KeyEncoder.textEncoder.encode(event.utf8);
      textLen = bytes.length;
      if (textLen > KeyEncoder.UTF8_CAPACITY) {
        ownedText = textPtr = ex.ghostty_wasm_alloc(textLen) >>> 0;
      }
      this.mem.refresh().u8.set(bytes, textPtr);
    }
    ex.ghostty_key_event_set_utf8(ev, textLen ? textPtr : 0, textLen);

    try {
      let result = ex.ghostty_key_encoder_encode(
        this.encoder,
        ev,
        this.outPtr,
        this.outCapacity,
        this.outLenPtr
      );
      if (result === this.layout.result.OUT_OF_SPACE) {
        this.growOutput(this.mem.refresh().u32[this.outLenPtr >>> 2]);
        result = ex.ghostty_key_encoder_encode(
          this.encoder,
          ev,
          this.outPtr,
          this.outCapacity,
          this.outLenPtr
        );
      }
      check(result, this.layout, 'ghostty_key_encoder_encode');
      const mem = this.mem.refresh();
      const length = mem.u32[this.outLenPtr >>> 2];
      return mem.u8.slice(this.outPtr, this.outPtr + length);
    } finally {
      ex.ghostty_key_event_set_utf8(ev, 0, 0);
      if (ownedText) ex.ghostty_wasm_free(ownedText, textLen);
    }
  }

  private growOutput(capacity: number): void {
    if (this.outPtr) this.exports.ghostty_wasm_free(this.outPtr, this.outCapacity);
    this.outCapacity = Math.max(64, capacity);
    this.outPtr = this.exports.ghostty_wasm_alloc(this.outCapacity) >>> 0;
  }

  dispose(): void {
    if (!this.encoder) return;
    this.exports.ghostty_key_event_free(this.event);
    this.exports.ghostty_key_encoder_free(this.encoder);
    this.exports.ghostty_wasm_free(this.outPtr, this.outCapacity);
    this.scratch.free();
    this.encoder = 0;
    this.event = 0;
  }
}

// ============================================================================
// Terminal
// ============================================================================

/** A cell style resolved for one row: colors are 0xRRGGBB, or -1 for the default. */
interface ResolvedStyle {
  fg: number;
  bg: number;
  attrs: number;
}

/** Where row cells come from while decoding: the render state or grid references. */
interface CellSource {
  /** Writes the style of cell x to the style struct; false when it has none. */
  style(x: number): boolean;
  /** The grapheme cluster of cell x. */
  graphemes(x: number): string;
}

/** A blank cell in the configured default colors. */
function blankCell(fg: number, bg: number): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: (fg >> 16) & 0xff,
    fg_g: (fg >> 8) & 0xff,
    fg_b: fg & 0xff,
    bg_r: (bg >> 16) & 0xff,
    bg_g: (bg >> 8) & 0xff,
    bg_b: bg & 0xff,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

/** One decoded row of cells, in typed arrays (the screen copy or a scratch row). */
class CellRows {
  codepoints: Uint32Array;
  fg: Uint32Array;
  bg: Uint32Array;
  attrs: Uint16Array;
  widths: Uint8Array;
  /** Codepoints beyond the first, per cell */
  graphemeExtra: Uint8Array;
  /** Full grapheme clusters by cell index, for cells with graphemeExtra > 0 */
  readonly graphemes = new Map<number, string>();
  wrapped: Uint8Array;

  constructor(
    readonly cols: number,
    readonly rows: number
  ) {
    const n = cols * rows;
    this.codepoints = new Uint32Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.attrs = new Uint16Array(n);
    this.widths = new Uint8Array(n).fill(1);
    this.graphemeExtra = new Uint8Array(n);
    this.wrapped = new Uint8Array(rows);
  }

  clearRowGraphemes(y: number): void {
    if (this.graphemes.size === 0) return;
    const start = y * this.cols;
    for (let x = 0; x < this.cols; x++) {
      if (this.graphemeExtra[start + x]) this.graphemes.delete(start + x);
    }
  }

  /** Copies cell i into a GhosttyCell object. */
  toCell(i: number, cell: GhosttyCell): GhosttyCell {
    const fg = this.fg[i];
    const bg = this.bg[i];
    cell.codepoint = this.codepoints[i];
    cell.fg_r = (fg >> 16) & 0xff;
    cell.fg_g = (fg >> 8) & 0xff;
    cell.fg_b = fg & 0xff;
    cell.bg_r = (bg >> 16) & 0xff;
    cell.bg_g = (bg >> 8) & 0xff;
    cell.bg_b = bg & 0xff;
    cell.flags = this.attrs[i] & 0xff;
    cell.width = this.widths[i];
    cell.hyperlink_id = this.attrs[i] & CellAttr.HYPERLINK ? 1 : 0;
    cell.grapheme_len = this.graphemeExtra[i];
    return cell;
  }
}

/**
 * GhosttyTerminal - one terminal emulator instance.
 *
 * Rows are read through the render state, which captures the viewport and
 * tracks which rows changed: `update()` copies only those into typed arrays.
 */
export class GhosttyTerminal {
  /** @internal The libghostty-vt terminal handle. */
  readonly handle: number;
  private readonly ghostty: Ghostty;
  private readonly exports: GhosttyWasmExports;
  private readonly mem: WasmMemory;
  private readonly layout: Layout;
  private renderState: number;
  private rowIterator: number;
  private rowCells: number;
  private _cols: number;
  private _rows: number;
  private freed = false;

  // Scratch slots passed to exports
  private readonly scratch: Scratch;
  private readonly outPtr: number;
  private readonly iteratorSlot: number;
  private readonly cellsSlot: number;
  private readonly cellsViewPtr: number;
  private readonly rowRawPtr: number;
  private readonly cellRawPtr: number;
  private readonly stylePtr: number;
  private readonly colorsPtr: number;
  private readonly cursorPtr: number;
  private readonly scrollPtr: number;
  private readonly pointPtr: number;
  private readonly gridRefPtr: number;
  private readonly modePtr: number;
  private readonly stringPtr: number;
  private readonly outLenPtr: number;
  private readonly rgbPtr: number;
  private readonly palettePtr: number;
  private readonly graphemePtr: number;

  /** Reusable wasm buffer for write(); bigger writes get a one-off buffer. */
  private writeBufferPtr: number = 0;
  private writeBufferSize: number = 0;
  private static readonly MAX_POOLED_WRITE = 1 << 20;
  private static readonly encoder = new TextEncoder();
  private static readonly decoder = new TextDecoder();

  /** The screen as last read from the render state (the viewport). */
  private screen: CellRows;
  private rowDirty: Uint8Array;
  private dirty: DirtyState = DirtyState.FULL;
  /** Reused row objects (see getRowCells) */
  private rowView: GhosttyCell[] = [];
  private rowPool: GhosttyCell[] = [];
  /** A row read through grid references, and the raw cells it is decoded from */
  private gridRow: CellRows;
  private gridCellsPtr = 0;
  private gridCellsSize = 0;

  /** Colors from the render state, as 0xRRGGBB */
  private readonly palette = new Uint32Array(256);
  private defaultFg = DEFAULT_FOREGROUND;
  private defaultBg = DEFAULT_BACKGROUND;
  private cursorColor: number | null = null;
  private readonly cursorState: RenderStateCursor = {
    x: 0,
    y: 0,
    viewportX: -1,
    viewportY: -1,
    visible: true,
    blinking: false,
    style: 'block',
  };

  /** Something changed in the terminal since the render state last captured it. */
  private stale = true;
  /** The render state captured something update() hasn't copied yet. */
  private captured = false;
  /** Lines the viewport is scrolled up from the bottom, as last requested. */
  private viewportOffset = 0;

  // Synchronized output (render holds)
  private holdActive = false;
  private holdStartedAt = 0;
  private holdReleased = false;

  // Effects collected during writes, read by the Terminal afterwards
  private responses: string[] = [];
  private pendingBells = 0;
  private titleChanged = false;
  private cellWidthPx = 0;
  private cellHeightPx = 0;

  /** Row-local style cache: style ids are page-local, and a row lives in one page. */
  private readonly styleCache = new Map<number, ResolvedStyle>();
  private rowCellsLoaded = false;

  constructor(
    ghostty: Ghostty,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.ghostty = ghostty;
    this.exports = ghostty.exports;
    this.mem = ghostty.mem;
    this.layout = ghostty.layout;
    this._cols = cols;
    this._rows = rows;
    const ex = this.exports;
    const L = this.layout;

    this.scratch = new Scratch(ex, 4096);
    const s = this.scratch;
    this.outPtr = s.reserve(16);
    this.iteratorSlot = s.reserve(4, 4);
    this.cellsSlot = s.reserve(4, 4);
    this.cellsViewPtr = s.reserve(L.cellsView.size);
    this.rowRawPtr = s.reserve(8);
    this.cellRawPtr = s.reserve(8);
    this.stylePtr = s.reserve(L.style.size);
    this.colorsPtr = s.reserve(L.colors.size);
    this.cursorPtr = s.reserve(L.cursor.size);
    this.scrollPtr = s.reserve(L.scroll.size);
    this.pointPtr = s.reserve(L.point.size);
    this.gridRefPtr = s.reserve(L.gridRef.size);
    this.modePtr = s.reserve(L.mode.size);
    this.stringPtr = s.reserve(L.string.size);
    this.outLenPtr = s.reserve(4, 4);
    this.rgbPtr = s.reserve(4, 4);
    this.palettePtr = s.reserve(256 * 3, 4);
    this.graphemePtr = s.reserve(GRAPHEME_BUFFER_CODEPOINTS * 4, 4);

    this.handle = newHandle(ex, L, 'ghostty_terminal_new', (slot) =>
      ex.ghostty_terminal_new(0, slot, cols, rows)
    );
    this.renderState = newHandle(ex, L, 'ghostty_render_state_new', (slot) =>
      ex.ghostty_render_state_new(0, slot)
    );
    this.rowIterator = newHandle(ex, L, 'ghostty_render_state_row_iterator_new', (slot) =>
      ex.ghostty_render_state_row_iterator_new(0, slot)
    );
    this.rowCells = newHandle(ex, L, 'ghostty_render_state_row_cells_new', (slot) =>
      ex.ghostty_render_state_row_cells_new(0, slot)
    );
    ghostty.register(this);

    this.screen = new CellRows(cols, rows);
    this.rowDirty = new Uint8Array(rows);
    this.gridRow = new CellRows(cols, 1);

    this.installEffects();
    this.enableGraphemeClustering();
    this.configure(config ?? {});
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private installEffects(): void {
    const { opt } = this.layout;
    const effects = this.ghostty.effects;
    const set = (option: number, fn: number) =>
      check(this.exports.ghostty_terminal_set(this.handle, option, fn), this.layout, 'set effect');
    set(opt.WRITE_PTY, effects.writePty);
    set(opt.BELL, effects.bell);
    set(opt.TITLE_CHANGED, effects.titleChanged);
    set(opt.RENDER_HOLD, effects.renderHold);
    set(opt.DEVICE_ATTRIBUTES, effects.deviceAttributes);
    set(opt.SIZE, effects.size);
    set(opt.COLOR_SCHEME, effects.colorScheme);
  }

  /** Applies scrollback, default colors and cursor defaults. */
  private configure(config: GhosttyTerminalConfig): void {
    const ex = this.exports;
    const { opt } = this.layout;
    const mem = this.mem.refresh();

    // Scrollback is limited in lines (xterm.js semantics), not bytes. The line
    // limit prunes whole pages, so 0 would still keep a page: a byte limit of 0
    // is what keeps no scrollback at all.
    const lines = Math.max(0, Math.floor(config.scrollbackLimit ?? 10000));
    mem.u32[this.outPtr >>> 2] = lines;
    check(
      ex.ghostty_terminal_set(this.handle, opt.SCROLLBACK_MAX_LINES, this.outPtr),
      this.layout,
      'scrollback lines'
    );
    this.mem.refresh().u32[this.outPtr >>> 2] = 0;
    check(
      ex.ghostty_terminal_set(this.handle, opt.SCROLLBACK_MAX_BYTES, lines === 0 ? this.outPtr : 0),
      this.layout,
      'scrollback bytes'
    );

    this.setColors(config);

    const style = this.layout.cursorStyle[config.cursorStyle ?? 'block'];
    mem.view.setInt32(this.outPtr, style, true);
    check(
      ex.ghostty_terminal_set(this.handle, opt.DEFAULT_CURSOR_STYLE, this.outPtr),
      this.layout,
      'cursor style'
    );
    mem.u8[this.outPtr] = config.cursorBlink ? 1 : 0;
    check(
      ex.ghostty_terminal_set(this.handle, opt.DEFAULT_CURSOR_BLINK, this.outPtr),
      this.layout,
      'cursor blink'
    );
  }

  /**
   * Sets the default colors (0xRRGGBB; omitted ones keep their defaults).
   * Programs can still override them with OSC 4/10/11/12.
   */
  setColors(
    config: Pick<GhosttyTerminalConfig, 'fgColor' | 'bgColor' | 'cursorColor' | 'palette'>
  ): void {
    const ex = this.exports;
    const { opt, data } = this.layout;
    const setRgb = (option: number, color: number | undefined) => {
      if (color === undefined) {
        check(ex.ghostty_terminal_set(this.handle, option, 0), this.layout, 'color');
        return;
      }
      const u8 = this.mem.refresh().u8;
      u8[this.rgbPtr] = (color >> 16) & 0xff;
      u8[this.rgbPtr + 1] = (color >> 8) & 0xff;
      u8[this.rgbPtr + 2] = color & 0xff;
      check(ex.ghostty_terminal_set(this.handle, option, this.rgbPtr), this.layout, 'color');
    };
    setRgb(opt.COLOR_FOREGROUND, config.fgColor ?? DEFAULT_FOREGROUND);
    setRgb(opt.COLOR_BACKGROUND, config.bgColor ?? DEFAULT_BACKGROUND);
    setRgb(opt.COLOR_CURSOR, config.cursorColor);

    // The 256-color palette: libghostty-vt's default, with the 16 ANSI colors replaced
    check(
      ex.ghostty_terminal_get(this.handle, data.COLOR_PALETTE_DEFAULT, this.palettePtr),
      this.layout,
      'default palette'
    );
    const u8 = this.mem.refresh().u8;
    config.palette?.forEach((color, i) => {
      if (color === undefined || i >= 256) return;
      const p = this.palettePtr + i * 3;
      u8[p] = (color >> 16) & 0xff;
      u8[p + 1] = (color >> 8) & 0xff;
      u8[p + 2] = color & 0xff;
    });
    check(
      ex.ghostty_terminal_set(this.handle, opt.COLOR_PALETTE, this.palettePtr),
      this.layout,
      'palette'
    );
    this.stale = true;
  }

  /**
   * Grapheme clustering (mode 2027) on, also after resets: emoji sequences and
   * combining marks then take one cell, as programs expect.
   */
  private enableGraphemeClustering(): void {
    const { opt, result } = this.layout;
    this.writeModeConfig(MODE_GRAPHEME_CLUSTER, false, true);
    if (
      this.exports.ghostty_terminal_set(this.handle, opt.MODE_DEFAULT, this.modePtr) !==
      result.SUCCESS
    ) {
      this.setOptionMode(opt.MODE, MODE_GRAPHEME_CLUSTER, false, true);
    }
  }

  /** Sets a mode (current value or the value resets restore). */
  private setOptionMode(option: number, mode: number, ansi: boolean, value: boolean): void {
    this.writeModeConfig(mode, ansi, value);
    check(
      this.exports.ghostty_terminal_set(this.handle, option, this.modePtr),
      this.layout,
      `mode ${mode}`
    );
  }

  private writeModeConfig(mode: number, ansi: boolean, value: boolean): void {
    const mem = this.mem.refresh();
    const { mode: m } = this.layout;
    mem.view.setUint16(this.modePtr + m.mode, (mode & 0x7fff) | (ansi ? MODE_ANSI_BIT : 0), true);
    mem.u8[this.modePtr + m.value] = value ? 1 : 0;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const ex = this.exports;
    // UTF-8 takes at most 3 bytes per UTF-16 code unit
    const size = typeof data === 'string' ? data.length * 3 : data.length;
    if (size === 0) return;
    const pooled = size <= GhosttyTerminal.MAX_POOLED_WRITE;
    let ptr: number;
    if (pooled) {
      if (this.writeBufferSize < size || !this.writeBufferPtr) {
        if (this.writeBufferPtr) {
          ex.ghostty_wasm_free(this.writeBufferPtr, this.writeBufferSize);
        }
        const capacity = Math.max(4096, size);
        this.writeBufferPtr = ex.ghostty_wasm_alloc(capacity) >>> 0;
        this.writeBufferSize = capacity;
      }
      ptr = this.writeBufferPtr;
    } else {
      ptr = ex.ghostty_wasm_alloc(size) >>> 0;
    }
    if (!ptr) throw new Error('Failed to allocate wasm memory for write');
    let length: number;
    const mem = this.mem.refresh();
    if (typeof data === 'string') {
      const target = mem.u8.subarray(ptr, ptr + size);
      length = GhosttyTerminal.encoder.encodeInto(data, target).written ?? 0;
    } else {
      mem.u8.set(data, ptr);
      length = data.length;
    }
    ex.ghostty_terminal_vt_write(this.handle, ptr, length);
    if (!pooled) ex.ghostty_wasm_free(ptr, size);
    this.stale = true;
  }

  /**
   * Resizes the grid. The cell size in pixels feeds size reports (XTWINOPS,
   * mode 2048); pass the renderer's when it is known.
   */
  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void {
    if (cellWidthPx !== undefined) this.cellWidthPx = Math.round(cellWidthPx);
    if (cellHeightPx !== undefined) this.cellHeightPx = Math.round(cellHeightPx);
    const sizeChanged = cols !== this._cols || rows !== this._rows;
    if (!sizeChanged && cellWidthPx === undefined) return;
    check(
      this.exports.ghostty_terminal_resize(
        this.handle,
        cols,
        rows,
        this.cellWidthPx,
        this.cellHeightPx
      ),
      this.layout,
      'ghostty_terminal_resize'
    );
    if (sizeChanged) {
      this._cols = cols;
      this._rows = rows;
      this.screen = new CellRows(cols, rows);
      this.rowDirty = new Uint8Array(rows);
      this.gridRow = new CellRows(cols, 1);
    }
    this.stale = true;
    this.dirty = DirtyState.FULL;
    // update() won't refill the new grid while the hold lasts
    if (this.holdActive) this.captureRenderState();
  }

  /** Full reset (RIS): screen, scrollback, modes, title. Colors and limits stay. */
  reset(): void {
    this.exports.ghostty_terminal_reset(this.handle);
    this.viewportOffset = 0;
    this.responses = [];
    this.titleChanged = false;
    this.stale = true;
    this.dirty = DirtyState.FULL;
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    const ex = this.exports;
    this.ghostty.unregister(this);
    ex.ghostty_render_state_row_cells_free(this.rowCells);
    ex.ghostty_render_state_row_iterator_free(this.rowIterator);
    ex.ghostty_render_state_free(this.renderState);
    ex.ghostty_terminal_free(this.handle);
    if (this.writeBufferPtr) {
      ex.ghostty_wasm_free(this.writeBufferPtr, this.writeBufferSize);
      this.writeBufferPtr = 0;
      this.writeBufferSize = 0;
    }
    if (this.gridCellsPtr) {
      ex.ghostty_wasm_free(this.gridCellsPtr, this.gridCellsSize);
      this.gridCellsPtr = 0;
    }
    this.scratch.free();
  }

  // ==========================================================================
  // Effects (called by libghostty-vt during writes)
  // ==========================================================================

  /** @internal */
  onWritePty(ptr: number, len: number): void {
    const bytes = this.mem.refresh().u8.slice(ptr, ptr + len);
    this.responses.push(GhosttyTerminal.decoder.decode(bytes));
  }

  /** @internal */
  onBell(): void {
    this.pendingBells++;
  }

  /** @internal */
  onTitleChanged(): void {
    this.titleChanged = true;
  }

  /**
   * @internal A program began or ended a synchronized frame (mode 2026). At
   * the start the terminal holds exactly the frame to keep showing, so the
   * render state captures it now and stays as is until the hold ends.
   */
  onRenderHold(held: boolean): void {
    if (held) {
      // No throwing here: an exception would unwind through libghostty-vt mid-write
      if (
        this.exports.ghostty_render_state_update(this.renderState, this.handle) ===
        this.layout.result.SUCCESS
      ) {
        this.stale = false;
        this.captured = true;
      }
      this.holdActive = true;
      this.holdStartedAt = now();
    } else if (this.holdActive) {
      this.holdActive = false;
      this.holdReleased = true;
      this.stale = true;
    }
  }

  /** @internal */
  onDeviceAttributes(out: number): boolean {
    const view = this.mem.refresh().view;
    const { da } = this.layout;
    view.setUint16(out + da.conformance, DA1_CONFORMANCE_LEVEL, true);
    DA1_FEATURES.forEach((feature, i) => view.setUint16(out + da.features + i * 2, feature, true));
    view.setUint32(out + da.numFeatures, DA1_FEATURES.length, true);
    view.setUint16(out + da.deviceType, DA2.deviceType, true);
    view.setUint16(out + da.firmwareVersion, DA2.firmwareVersion, true);
    view.setUint16(out + da.romCartridge, DA2.romCartridge, true);
    view.setUint32(out + da.unitId, 0, true);
    return true;
  }

  /** @internal */
  onSizeReport(out: number): boolean {
    const view = this.mem.refresh().view;
    const { sizeReport } = this.layout;
    view.setUint16(out + sizeReport.rows, this._rows, true);
    view.setUint16(out + sizeReport.columns, this._cols, true);
    view.setUint32(out + sizeReport.cellWidth, this.cellWidthPx, true);
    view.setUint32(out + sizeReport.cellHeight, this.cellHeightPx, true);
    return true;
  }

  /** @internal Dark when the background (theme default or OSC 11) is dark. */
  onColorScheme(out: number): boolean {
    const { data, result } = this.layout;
    if (
      this.exports.ghostty_terminal_get(this.handle, data.COLOR_BACKGROUND, this.rgbPtr) !==
      result.SUCCESS
    ) {
      return false;
    }
    const u8 = this.mem.refresh().u8;
    const bg = (u8[this.rgbPtr] << 16) | (u8[this.rgbPtr + 1] << 8) | u8[this.rgbPtr + 2];
    const luminance =
      0.2126 * ((bg >> 16) & 0xff) + 0.7152 * ((bg >> 8) & 0xff) + 0.0722 * (bg & 0xff);
    const scheme = luminance < 128 ? this.layout.colorScheme.DARK : this.layout.colorScheme.LIGHT;
    this.mem.refresh().view.setInt32(out, scheme, true);
    return true;
  }

  /** Bells rung (BEL outside escape sequences) since the last call. */
  takeBells(): number {
    const bells = this.pendingBells;
    this.pendingBells = 0;
    return bells;
  }

  /** The title, if a program set it (OSC 0/2) since the last call; else null. */
  takeTitleChange(): string | null {
    if (!this.titleChanged) return null;
    this.titleChanged = false;
    return this.getTitle();
  }

  /** True once after a program finishes a synchronized frame: draw it now. */
  takeRenderHoldRelease(): boolean {
    const released = this.holdReleased;
    this.holdReleased = false;
    return released;
  }

  /** Whether a program is holding the screen (synchronized output). */
  get renderHoldActive(): boolean {
    return this.holdActive;
  }

  /** Milliseconds left before the current hold is released anyway (0 when none). */
  get renderHoldRemainingMs(): number {
    if (!this.holdActive) return 0;
    return Math.max(0, RENDER_HOLD_TIMEOUT_MS - (now() - this.holdStartedAt));
  }

  /** The title set by OSC 0/2 ('' when none). */
  getTitle(): string {
    if (
      this.exports.ghostty_terminal_get(this.handle, this.layout.data.TITLE, this.stringPtr) !==
      this.layout.result.SUCCESS
    ) {
      return '';
    }
    const mem = this.mem.refresh();
    const ptr = mem.u32[(this.stringPtr + this.layout.string.ptr) >>> 2];
    const len = mem.u32[(this.stringPtr + this.layout.string.len) >>> 2];
    return len ? GhosttyTerminal.decoder.decode(mem.u8.subarray(ptr, ptr + len)) : '';
  }

  /**
   * Check if there are pending responses from the terminal.
   * Responses are replies to queries such as DSR (cursor position) or DA.
   */
  hasResponse(): boolean {
    return this.responses.length > 0;
  }

  /**
   * Read the pending responses (to send back to the PTY), or null if none.
   */
  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    const response = this.responses.join('');
    this.responses = [];
    return response;
  }

  // ==========================================================================
  // RenderState API
  // ==========================================================================

  /**
   * Brings the screen copy up to date and returns what changed since the last
   * markClean(). Cheap when nothing changed. While a program holds the screen
   * (synchronized output) the copy keeps the frame it held, until it releases
   * it or RENDER_HOLD_TIMEOUT_MS passes.
   */
  update(): DirtyState {
    if (this.holdActive && now() - this.holdStartedAt >= RENDER_HOLD_TIMEOUT_MS) {
      this.releaseHold();
    }
    if (this.stale && !this.holdActive) this.captureRenderState();
    if (this.captured) this.copyRenderState();
    return this.dirty;
  }

  /** Ends a hold the program didn't (it set mode 2026 and kept it). */
  private releaseHold(): void {
    this.setOptionMode(this.layout.opt.MODE, MODE_SYNC_OUTPUT, false, false);
    this.holdActive = false;
    this.stale = true;
  }

  private captureRenderState(): void {
    check(
      this.exports.ghostty_render_state_update(this.renderState, this.handle),
      this.layout,
      'ghostty_render_state_update'
    );
    this.stale = false;
    this.captured = true;
  }

  /** Copies the rows the render state marks dirty, then marks it clean. */
  private copyRenderState(): void {
    this.captured = false;
    const ex = this.exports;
    const L = this.layout;
    const rs = this.renderState;
    check(ex.ghostty_render_state_get(rs, L.rs.DIRTY, this.outPtr), L, 'render state dirty');
    const dirty = this.mem.refresh().i32[this.outPtr >>> 2];
    if (dirty === L.rs.dirtyFalse) return;

    this.readColors();
    this.readCursor();

    this.mem.refresh().u32[this.iteratorSlot >>> 2] = this.rowIterator;
    check(ex.ghostty_render_state_get(rs, L.rs.ROW_ITERATOR, this.iteratorSlot), L, 'row iterator');
    const rowSource: CellSource = {
      style: (x) => this.rowCellsGet(x, L.rowCells.STYLE, this.stylePtr),
      graphemes: (x) => this.rowCellsGraphemes(x),
    };
    while (ex.ghostty_render_state_row_iterator_next_dirty(this.rowIterator, this.outPtr)) {
      const y = this.mem.refresh().u16[this.outPtr >>> 1];
      if (y >= this._rows) continue;
      this.rowCellsLoaded = false;
      check(
        ex.ghostty_render_state_row_get(this.rowIterator, L.row.CELLS_RAW, this.cellsViewPtr),
        L,
        'row cells'
      );
      const mem = this.mem.refresh();
      const cells = mem.u32[(this.cellsViewPtr + L.cellsView.ptr) >>> 2];
      const len = mem.u32[(this.cellsViewPtr + L.cellsView.len) >>> 2];
      this.screen.clearRowGraphemes(y);
      this.decodeRow(this.screen, y, cells, len, rowSource);
      ex.ghostty_render_state_row_get(this.rowIterator, L.row.RAW, this.rowRawPtr);
      this.screen.wrapped[y] = this.rowContinues(this.rowRawPtr) ? 1 : 0;
      this.rowDirty[y] = 1;
    }
    ex.ghostty_render_state_clean(rs);
    if (dirty === L.rs.dirtyFull) {
      this.dirty = DirtyState.FULL;
    } else if (this.dirty === DirtyState.NONE) {
      this.dirty = DirtyState.PARTIAL;
    }
  }

  private readColors(): void {
    const L = this.layout.colors;
    this.mem.refresh().u32[(this.colorsPtr + L.sizeField) >>> 2] = L.size;
    check(
      this.exports.ghostty_render_state_get(
        this.renderState,
        this.layout.rs.COLORS,
        this.colorsPtr
      ),
      this.layout,
      'render state colors'
    );
    const u8 = this.mem.refresh().u8;
    const rgb = (p: number) => (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
    this.defaultBg = rgb(this.colorsPtr + L.background);
    this.defaultFg = rgb(this.colorsPtr + L.foreground);
    this.cursorColor = u8[this.colorsPtr + L.cursorHasValue]
      ? rgb(this.colorsPtr + L.cursor)
      : null;
    const palette = this.palette;
    for (let i = 0; i < 256; i++) palette[i] = rgb(this.colorsPtr + L.palette + i * 3);
  }

  private readCursor(): void {
    const L = this.layout.cursor;
    this.mem.refresh().u32[(this.cursorPtr + L.sizeField) >>> 2] = L.size;
    check(
      this.exports.ghostty_render_state_get(
        this.renderState,
        this.layout.rs.CURSOR,
        this.cursorPtr
      ),
      this.layout,
      'render state cursor'
    );
    const mem = this.mem.refresh();
    const p = this.cursorPtr;
    const c = this.cursorState;
    const onScreen = mem.u8[p + L.viewportHasValue] !== 0;
    c.viewportX = onScreen ? mem.view.getUint16(p + L.viewportX, true) : -1;
    c.viewportY = onScreen ? mem.view.getUint16(p + L.viewportY, true) : -1;
    c.visible = mem.u8[p + L.visible] !== 0;
    c.blinking = mem.u8[p + L.blinking] !== 0;
    c.style = this.layout.visualStyle[mem.view.getInt32(p + L.visualStyle, true)] ?? 'block';
  }

  /** Reads a cell value for the current render-state row (populating its cells once). */
  private rowCellsGet(x: number, data: number, out: number): boolean {
    const ex = this.exports;
    const L = this.layout;
    if (!this.rowCellsLoaded) {
      this.mem.refresh().u32[this.cellsSlot >>> 2] = this.rowCells;
      check(
        ex.ghostty_render_state_row_get(this.rowIterator, L.row.CELLS, this.cellsSlot),
        L,
        'row cells'
      );
      this.rowCellsLoaded = true;
    }
    if (ex.ghostty_render_state_row_cells_select(this.rowCells, x) !== L.result.SUCCESS)
      return false;
    if (data === L.rowCells.STYLE) {
      this.mem.refresh().u32[(this.stylePtr + L.style.sizeField) >>> 2] = L.style.size;
    }
    return ex.ghostty_render_state_row_cells_get(this.rowCells, data, out) === L.result.SUCCESS;
  }

  private rowCellsGraphemes(x: number): string {
    const L = this.layout;
    if (!this.rowCellsGet(x, L.rowCells.GRAPHEMES_LEN, this.outPtr)) return '';
    const len = this.mem.refresh().u32[this.outPtr >>> 2];
    if (len === 0) return '';
    const big = len > GRAPHEME_BUFFER_CODEPOINTS;
    const buf = big ? this.exports.ghostty_wasm_alloc(len * 4) >>> 0 : this.graphemePtr;
    try {
      if (!this.rowCellsGet(x, L.rowCells.GRAPHEMES_BUF, buf)) return '';
      return String.fromCodePoint(...this.mem.refresh().u32.subarray(buf >>> 2, (buf >>> 2) + len));
    } finally {
      if (big) this.exports.ghostty_wasm_free(buf, len * 4);
    }
  }

  /**
   * Whether the raw row value (GhosttyRow, a u64) at `ptr` continues the row
   * above it, soft-wrapped there.
   */
  private rowContinues(ptr: number): boolean {
    const u32 = this.mem.refresh().u32;
    const row = (BigInt(u32[(ptr >>> 2) + 1]) << 32n) | BigInt(u32[ptr >>> 2]);
    const { row: R, result } = this.layout;
    if (this.exports.ghostty_row_get(row, R.WRAP_CONTINUATION, this.outPtr) !== result.SUCCESS) {
      return false;
    }
    return this.mem.refresh().u8[this.outPtr] !== 0;
  }

  /**
   * Decodes `len` raw cells (GhosttyCell, u64 each) at `ptr` into row `y` of
   * `target`, resolving styles and graphemes through `source`.
   */
  private decodeRow(
    target: CellRows,
    y: number,
    ptr: number,
    len: number,
    source: CellSource
  ): void {
    const C = this.layout.cell;
    const cols = target.cols;
    const base = y * cols;
    const count = Math.min(len, cols);
    const styles = this.styleCache;
    styles.clear();
    let u32 = this.mem.refresh().u32;
    let word = ptr >>> 2;
    for (let x = 0; x < count; x++, word += 2) {
      const lo = u32[word];
      const hi = u32[word + 1];
      const i = base + x;
      const tag = readBits(lo, hi, C.tag);
      const wide = readBits(lo, hi, C.wide);
      let codepoint = 0;
      let bg = -1;
      if (tag === C.BG_COLOR_PALETTE) {
        bg = this.palette[readBits(lo, hi, C.paletteIndex)];
      } else if (tag === C.BG_COLOR_RGB) {
        bg =
          (readBits(lo, hi, C.bgR) << 16) |
          (readBits(lo, hi, C.bgG) << 8) |
          readBits(lo, hi, C.bgB);
      } else {
        codepoint = readBits(lo, hi, C.codepoint);
      }

      let fg = -1;
      let attrs = 0;
      const styleId = readBits(lo, hi, C.styleId);
      if (styleId !== 0) {
        let style = styles.get(styleId);
        if (!style) {
          style = source.style(x) ? this.readStyle() : { fg: -1, bg: -1, attrs: 0 };
          styles.set(styleId, style);
          u32 = this.mem.refresh().u32;
        }
        fg = style.fg;
        if (bg < 0) bg = style.bg;
        attrs = style.attrs;
      }
      if (readBits(lo, hi, C.hyperlink)) attrs |= CellAttr.HYPERLINK;

      let extra = 0;
      if (tag === C.CODEPOINT_GRAPHEME) {
        const cluster = source.graphemes(x);
        u32 = this.mem.refresh().u32;
        if (cluster) {
          // Count codepoints beyond the first (surrogate pairs are one codepoint)
          for (const _ of cluster) extra++;
          extra = Math.max(0, extra - 1);
          if (extra > 0) target.graphemes.set(i, cluster);
        }
      }

      target.codepoints[i] = codepoint;
      target.fg[i] = fg < 0 ? this.defaultFg : fg;
      target.bg[i] = bg < 0 ? this.defaultBg : bg;
      target.attrs[i] = attrs;
      target.widths[i] = wide === C.WIDE ? 2 : wide === C.SPACER_TAIL ? 0 : 1;
      target.graphemeExtra[i] = Math.min(extra, 255);
    }
    // Columns the view didn't cover (not expected) stay blank
    for (let x = count; x < cols; x++) {
      const i = base + x;
      target.codepoints[i] = 0;
      target.fg[i] = this.defaultFg;
      target.bg[i] = this.defaultBg;
      target.attrs[i] = 0;
      target.widths[i] = 1;
      target.graphemeExtra[i] = 0;
    }
  }

  /** Decodes the style struct at stylePtr. */
  private readStyle(): ResolvedStyle {
    const mem = this.mem.refresh();
    const S = this.layout.style;
    const p = this.stylePtr;
    const color = (c: { tag: number; value: number }): number => {
      const tag = mem.view.getInt32(p + c.tag, true);
      if (tag === S.PALETTE) return this.palette[mem.u8[p + c.value]];
      if (tag === S.RGB) {
        const v = p + c.value;
        return (mem.u8[v + S.rgb.r] << 16) | (mem.u8[v + S.rgb.g] << 8) | mem.u8[v + S.rgb.b];
      }
      return -1;
    };
    const u8 = mem.u8;
    const underline = mem.view.getInt32(p + S.underline, true);
    let attrs = 0;
    if (u8[p + S.bold]) attrs |= CellFlags.BOLD;
    if (u8[p + S.italic]) attrs |= CellFlags.ITALIC;
    if (underline > 0)
      attrs |= CellFlags.UNDERLINE | ((underline & 0x7) << CellAttr.UNDERLINE_SHIFT);
    if (u8[p + S.strikethrough]) attrs |= CellFlags.STRIKETHROUGH;
    if (u8[p + S.inverse]) attrs |= CellFlags.INVERSE;
    if (u8[p + S.invisible]) attrs |= CellFlags.INVISIBLE;
    if (u8[p + S.blink]) attrs |= CellFlags.BLINK;
    if (u8[p + S.faint]) attrs |= CellFlags.FAINT;
    if (u8[p + S.overline]) attrs |= CellAttr.OVERLINE;
    return { fg: color(S.fg), bg: color(S.bg), attrs };
  }

  /**
   * Get cursor state: its active-area position, its viewport position (-1
   * when scrolled away), visibility, blinking and shape.
   */
  getCursor(): RenderStateCursor {
    this.update();
    const ex = this.exports;
    const { data } = this.layout;
    ex.ghostty_terminal_get(this.handle, data.CURSOR_X, this.outPtr);
    ex.ghostty_terminal_get(this.handle, data.CURSOR_Y, this.outPtr + 2);
    const u16 = this.mem.refresh().u16;
    this.cursorState.x = u16[this.outPtr >>> 1];
    this.cursorState.y = u16[(this.outPtr + 2) >>> 1];
    return this.cursorState;
  }

  /** The default background as 0xRRGGBB: what cells without a background color hold. */
  getDefaultBackground(): number {
    this.update();
    return this.defaultBg;
  }

  /**
   * Get the terminal's current default colors
   */
  getColors(): RenderStateColors {
    this.update();
    const rgb = (c: number): RGB => ({ r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff });
    return {
      background: rgb(this.defaultBg),
      foreground: rgb(this.defaultFg),
      cursor: this.cursorColor === null ? null : rgb(this.cursorColor),
    };
  }

  /**
   * Check if a viewport row changed since the last markClean()
   */
  isRowDirty(y: number): boolean {
    return this.dirty === DirtyState.FULL || this.rowDirty[y] === 1;
  }

  /**
   * Mark everything as drawn (call after rendering)
   */
  markClean(): void {
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(0);
  }

  /**
   * All viewport cells as GhosttyCell objects (row-major), for callers that
   * want the whole screen at once.
   */
  getViewport(): GhosttyCell[] {
    this.update();
    const n = this._cols * this._rows;
    while (this.rowPool.length < n) this.rowPool.push(blankCell(this.defaultFg, this.defaultBg));
    const cells = this.rowPool.slice(0, n);
    for (let i = 0; i < n; i++) this.screen.toCell(i, cells[i]);
    return cells;
  }

  // ==========================================================================
  // Row access
  // ==========================================================================

  /**
   * Active-area row y (the bottom screenful, whatever the viewport shows), as
   * copies of its cells.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    const rows = this.activeRow(y);
    if (!rows) return null;
    const line: GhosttyCell[] = new Array(this._cols);
    const base = rows === this.screen ? y * this._cols : 0;
    for (let x = 0; x < this._cols; x++) line[x] = rows.toCell(base + x, blankCell(0, 0));
    return line;
  }

  /**
   * Active-area row y without fresh objects: the array and its cells are
   * reused by the next call.
   */
  getRowCells(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    const rows = this.activeRow(y);
    if (!rows) return null;
    return this.fillRowView(rows, rows === this.screen ? y * this._cols : 0);
  }

  /**
   * Viewport row y (what the screen shows, scrolled or not) without fresh
   * objects: the array and its cells are reused by the next call.
   */
  getViewportRowCells(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    this.update();
    return this.fillRowView(this.screen, y * this._cols);
  }

  /**
   * The viewport as typed arrays (see ViewportCellData), without copies:
   * valid until the next update (any read after a write or a scroll).
   */
  getViewportCellData(): ViewportCellData {
    this.update();
    return this.screen;
  }

  /** The full grapheme cluster of viewport cell (x, y), or null when it has none. */
  getViewportGrapheme(y: number, x: number): string | null {
    return this.screen.graphemes.get(y * this._cols + x) ?? null;
  }

  private fillRowView(rows: CellRows, base: number): GhosttyCell[] {
    const cols = this._cols;
    while (this.rowPool.length < cols) this.rowPool.push(blankCell(this.defaultFg, this.defaultBg));
    const row = this.rowView;
    row.length = cols;
    for (let x = 0; x < cols; x++) row[x] = rows.toCell(base + x, this.rowPool[x]);
    return row;
  }

  /** The cells of active row y: the screen copy when it shows the active area, else read now. */
  private activeRow(y: number): CellRows | null {
    this.update();
    if (this.viewportOffset === 0 && !this.holdActive) return this.screen;
    return this.readGridRow(this.layout.point.ACTIVE, y) ? this.gridRow : null;
  }

  /** For compatibility with old API */
  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Viewport
  // ==========================================================================

  /**
   * Shows the screen `linesFromBottom` lines up into the scrollback (0 =
   * follow the output). Ignores a render hold: scrolling shows live content.
   */
  scrollViewport(linesFromBottom: number): void {
    const S = this.layout.scroll;
    const scrollback = this.getScrollbackLength();
    const offset = Math.max(0, Math.min(scrollback, Math.floor(linesFromBottom)));
    const view = this.mem.refresh().view;
    if (offset === 0) {
      view.setInt32(this.scrollPtr + S.tag, S.BOTTOM, true);
    } else {
      view.setInt32(this.scrollPtr + S.tag, S.ROW, true);
      view.setUint32(this.scrollPtr + S.value, scrollback - offset, true);
    }
    this.exports.ghostty_terminal_scroll_viewport(this.handle, this.scrollPtr);
    this.viewportOffset = offset;
    this.stale = true;
    if (this.holdActive) this.captureRenderState();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    this.exports.ghostty_terminal_get(this.handle, this.layout.data.ACTIVE_SCREEN, this.outPtr);
    return this.mem.refresh().i32[this.outPtr >>> 2] === this.layout.screenAlternate;
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    this.exports.ghostty_terminal_get(this.handle, this.layout.data.MOUSE_TRACKING, this.outPtr);
    return this.mem.refresh().u8[this.outPtr] !== 0;
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    this.writeModeConfig(mode, isAnsi, false);
    if (
      this.exports.ghostty_terminal_get(this.handle, this.layout.data.MODE, this.modePtr) !==
      this.layout.result.SUCCESS
    ) {
      return false;
    }
    return this.mem.refresh().u8[this.modePtr + this.layout.mode.value] !== 0;
  }

  // ==========================================================================
  // Scrollback and grid access
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    this.exports.ghostty_terminal_get(this.handle, this.layout.data.SCROLLBACK_ROWS, this.outPtr);
    return this.mem.refresh().u32[this.outPtr >>> 2];
  }

  /**
   * Get a line from the scrollback buffer, as copies of its cells.
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.readGridRow(this.layout.point.HISTORY, offset)) return null;
    const line: GhosttyCell[] = new Array(this._cols);
    for (let x = 0; x < this._cols; x++) line[x] = this.gridRow.toCell(x, blankCell(0, 0));
    return line;
  }

  /**
   * A scrollback line without fresh objects: the array and its cells are
   * reused by the next call.
   */
  getScrollbackRowCells(offset: number): GhosttyCell[] | null {
    if (!this.readGridRow(this.layout.point.HISTORY, offset)) return null;
    return this.fillRowView(this.gridRow, 0);
  }

  /**
   * Whether active-area row `row` continues the row above it (soft-wrapped:
   * xterm.js `isWrapped`).
   */
  isRowWrapped(row: number): boolean {
    if (!this.gridRef(this.layout.point.ACTIVE, 0, row)) return false;
    return this.gridRefRowContinues();
  }

  /** Whether a scrollback line continues the line above it (soft-wrapped). */
  isScrollbackRowWrapped(offset: number): boolean {
    if (!this.gridRef(this.layout.point.HISTORY, 0, offset)) return false;
    return this.gridRefRowContinues();
  }

  private gridRefRowContinues(): boolean {
    if (
      this.exports.ghostty_grid_ref_row(this.gridRefPtr, this.rowRawPtr) !==
      this.layout.result.SUCCESS
    ) {
      return false;
    }
    return this.rowContinues(this.rowRawPtr);
  }

  /**
   * Get the hyperlink URI for a cell at the given position.
   * @param row Row index (0-based, in the active area)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getHyperlinkUri(row: number, col: number): string | null {
    return this.hyperlinkUri(this.layout.point.ACTIVE, col, row);
  }

  /**
   * Get the hyperlink URI for a cell in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest, scrollback_len-1 = newest)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.hyperlinkUri(this.layout.point.HISTORY, col, offset);
  }

  private hyperlinkUri(tag: number, x: number, y: number): string | null {
    if (!this.gridRef(tag, x, y)) return null;
    const ex = this.exports;
    const L = this.layout;
    let capacity = 2048;
    for (let attempt = 0; attempt < 2; attempt++) {
      const size = capacity;
      const buf = ex.ghostty_wasm_alloc(size) >>> 0;
      try {
        const result = ex.ghostty_grid_ref_hyperlink_uri(
          this.gridRefPtr,
          buf,
          size,
          this.outLenPtr
        );
        const mem = this.mem.refresh();
        const len = mem.u32[this.outLenPtr >>> 2];
        if (result === L.result.OUT_OF_SPACE) {
          capacity = len;
          continue;
        }
        if (result !== L.result.SUCCESS || len === 0) return null;
        return GhosttyTerminal.decoder.decode(mem.u8.slice(buf, buf + len));
      } finally {
        ex.ghostty_wasm_free(buf, size);
      }
    }
    return null;
  }

  /**
   * Get all codepoints for a grapheme cluster at the given position.
   * For most cells this returns a single codepoint, but for complex scripts
   * (Hindi, emoji with ZWJ, etc.) it returns multiple codepoints.
   * @returns Array of codepoints, or null on error
   */
  getGrapheme(row: number, col: number): number[] | null {
    const cluster = this.graphemeAt(this.layout.point.ACTIVE, col, row);
    return cluster === null ? null : Array.from(cluster, (c) => c.codePointAt(0)!);
  }

  /**
   * Get a string representation of the grapheme at the given position.
   * This properly handles complex scripts like Hindi, emoji with ZWJ, etc.
   */
  getGraphemeString(row: number, col: number): string {
    return this.graphemeAt(this.layout.point.ACTIVE, col, row) || ' ';
  }

  /**
   * Get all codepoints for a grapheme cluster in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest)
   * @param col Column index
   * @returns Array of codepoints, or null on error
   */
  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    const cluster = this.graphemeAt(this.layout.point.HISTORY, col, offset);
    return cluster === null ? null : Array.from(cluster, (c) => c.codePointAt(0)!);
  }

  /**
   * Get a string representation of a grapheme in the scrollback buffer.
   */
  getScrollbackGraphemeString(offset: number, col: number): string {
    return this.graphemeAt(this.layout.point.HISTORY, col, offset) || ' ';
  }

  /** The text of cell (x, y) in the given coordinate space; '' when empty, null when out of range. */
  private graphemeAt(tag: number, x: number, y: number): string | null {
    if (!this.gridRef(tag, x, y)) return null;
    return this.gridRefGraphemes();
  }

  private gridRefGraphemes(): string {
    const ex = this.exports;
    const L = this.layout;
    let capacity = GRAPHEME_BUFFER_CODEPOINTS;
    let buf = this.graphemePtr;
    let result = ex.ghostty_grid_ref_graphemes(this.gridRefPtr, buf, capacity, this.outLenPtr);
    let owned = false;
    if (result === L.result.OUT_OF_SPACE) {
      capacity = this.mem.refresh().u32[this.outLenPtr >>> 2];
      buf = ex.ghostty_wasm_alloc(capacity * 4) >>> 0;
      owned = true;
      result = ex.ghostty_grid_ref_graphemes(this.gridRefPtr, buf, capacity, this.outLenPtr);
    }
    try {
      if (result !== L.result.SUCCESS) return '';
      const mem = this.mem.refresh();
      const len = mem.u32[this.outLenPtr >>> 2];
      return len ? String.fromCodePoint(...mem.u32.subarray(buf >>> 2, (buf >>> 2) + len)) : '';
    } finally {
      if (owned) ex.ghostty_wasm_free(buf, capacity * 4);
    }
  }

  /** Resolves (x, y) in the given coordinate space into the grid ref slot. */
  private gridRef(tag: number, x: number, y: number): boolean {
    const { point, gridRef } = this.layout;
    if (y < 0 || x < 0 || x >= this._cols) return false;
    const mem = this.mem.refresh();
    mem.view.setInt32(this.pointPtr + point.tag, tag, true);
    mem.view.setUint16(this.pointPtr + point.x, x, true);
    mem.view.setUint32(this.pointPtr + point.y, y, true);
    mem.u8.fill(0, this.gridRefPtr, this.gridRefPtr + gridRef.size);
    mem.view.setUint32(this.gridRefPtr + gridRef.sizeField, gridRef.size, true);
    return (
      this.exports.ghostty_terminal_grid_ref(this.handle, this.pointPtr, this.gridRefPtr) ===
      this.layout.result.SUCCESS
    );
  }

  /**
   * Reads row y of the given coordinate space (active area or history) into
   * gridRow, one grid reference per cell: fine for the occasional off-screen
   * row, too slow for a render loop.
   */
  private readGridRow(tag: number, y: number): boolean {
    this.update();
    if (!this.gridRef(tag, 0, y)) return false;
    const ex = this.exports;
    const L = this.layout;
    const cols = this._cols;
    if (this.gridCellsSize < cols * 8) {
      if (this.gridCellsPtr) ex.ghostty_wasm_free(this.gridCellsPtr, this.gridCellsSize);
      this.gridCellsSize = cols * 8;
      this.gridCellsPtr = ex.ghostty_wasm_alloc(this.gridCellsSize) >>> 0;
    }
    const cellsPtr = this.gridCellsPtr;
    // One raw cell at a time, moving the reference along its row
    for (let x = 0; x < cols; x++) {
      this.mem.refresh().view.setUint16(this.gridRefPtr + L.gridRef.x, x, true);
      if (ex.ghostty_grid_ref_cell(this.gridRefPtr, cellsPtr + x * 8) !== L.result.SUCCESS) {
        this.mem.refresh().u32.fill(0, (cellsPtr >>> 2) + x * 2, (cellsPtr >>> 2) + cols * 2);
        break;
      }
    }
    const source: CellSource = {
      style: (x) => {
        const mem = this.mem.refresh();
        mem.view.setUint16(this.gridRefPtr + L.gridRef.x, x, true);
        mem.u32[(this.stylePtr + L.style.sizeField) >>> 2] = L.style.size;
        return ex.ghostty_grid_ref_style(this.gridRefPtr, this.stylePtr) === L.result.SUCCESS;
      },
      graphemes: (x) => {
        this.mem.refresh().view.setUint16(this.gridRefPtr + L.gridRef.x, x, true);
        return this.gridRefGraphemes();
      },
    };
    this.gridRow.graphemes.clear();
    this.decodeRow(this.gridRow, 0, cellsPtr, cols, source);
    this.gridRow.wrapped[0] = this.gridRefRowContinues() ? 1 : 0;
    return true;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
