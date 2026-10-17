/**
 * TypeScript type definitions for libghostty-vt WASM API
 * Based on include/ghostty/vt/*.h from Ghostty repository
 */

// ============================================================================
// Key Encoder Types
// ============================================================================

/**
 * Kitty keyboard protocol flags
 * From include/ghostty/vt/key/encoder.h
 */
export enum KittyKeyFlags {
  DISABLED = 0,
  DISAMBIGUATE = 1 << 0, // Disambiguate escape codes
  REPORT_EVENTS = 1 << 1, // Report press and release
  REPORT_ALTERNATES = 1 << 2, // Report alternate key codes
  REPORT_ALL = 1 << 3, // Report all events
  REPORT_ASSOCIATED = 1 << 4, // Report associated text
  ALL = 0x1f, // All flags enabled
}

/**
 * Key encoder options (GhosttyKeyEncoderOption). The terminal's modes set most
 * of them: see KeyEncoder.syncFromTerminal().
 */
export enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 0, // DEC mode 1 (bool)
  KEYPAD_KEY_APPLICATION = 1, // DEC mode 66 (bool)
  IGNORE_KEYPAD_WITH_NUMLOCK = 2, // DEC mode 1035 (bool)
  ALT_ESC_PREFIX = 3, // DEC mode 1036 (bool)
  KITTY_KEYBOARD_FLAGS = 5, // Kitty protocol flags (KittyKeyFlags)
  MACOS_OPTION_AS_ALT = 6, // Which macOS Option keys act as Alt (0 none, 1 both, 2 left, 3 right)
  BACKARROW_KEY_MODE = 7, // DEC mode 67: Backspace sends BS instead of DEL (bool)
}

/**
 * Key action
 */
export enum KeyAction {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}

/**
 * Physical key codes matching Ghostty's internal Key enum.
 * These values are used by Ghostty's key encoder to produce correct escape sequences.
 * Reference: ghostty/src/input/key.zig
 */
export enum Key {
  // Unidentified key
  UNIDENTIFIED = 0,

  // Writing System Keys
  GRAVE = 1, // ` and ~
  BACKSLASH = 2, // \ and |
  BRACKET_LEFT = 3, // [ and {
  BRACKET_RIGHT = 4, // ] and }
  COMMA = 5, // , and <
  ZERO = 6,
  ONE = 7,
  TWO = 8,
  THREE = 9,
  FOUR = 10,
  FIVE = 11,
  SIX = 12,
  SEVEN = 13,
  EIGHT = 14,
  NINE = 15,
  EQUAL = 16, // = and +
  INTL_BACKSLASH = 17,
  INTL_RO = 18,
  INTL_YEN = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  MINUS = 46, // - and _
  PERIOD = 47, // . and >
  QUOTE = 48, // ' and "
  SEMICOLON = 49, // ; and :
  SLASH = 50, // / and ?

  // Functional Keys
  ALT_LEFT = 51,
  ALT_RIGHT = 52,
  BACKSPACE = 53,
  CAPS_LOCK = 54,
  CONTEXT_MENU = 55,
  CONTROL_LEFT = 56,
  CONTROL_RIGHT = 57,
  ENTER = 58,
  META_LEFT = 59,
  META_RIGHT = 60,
  SHIFT_LEFT = 61,
  SHIFT_RIGHT = 62,
  SPACE = 63,
  TAB = 64,
  CONVERT = 65,
  KANA_MODE = 66,
  NON_CONVERT = 67,

  // Control Pad Section
  DELETE = 68,
  END = 69,
  HELP = 70,
  HOME = 71,
  INSERT = 72,
  PAGE_DOWN = 73,
  PAGE_UP = 74,

  // Arrow Pad Section
  DOWN = 75,
  LEFT = 76,
  RIGHT = 77,
  UP = 78,

  // Numpad Section
  NUM_LOCK = 79,
  KP_0 = 80,
  KP_1 = 81,
  KP_2 = 82,
  KP_3 = 83,
  KP_4 = 84,
  KP_5 = 85,
  KP_6 = 86,
  KP_7 = 87,
  KP_8 = 88,
  KP_9 = 89,
  KP_PLUS = 90, // Keypad +
  KP_BACKSPACE = 91,
  KP_CLEAR = 92,
  KP_CLEAR_ENTRY = 93,
  KP_COMMA = 94,
  KP_PERIOD = 95, // Keypad .
  KP_DIVIDE = 96, // Keypad /
  KP_ENTER = 97, // Keypad Enter
  KP_EQUAL = 98,
  KP_MEMORY_ADD = 99,
  KP_MEMORY_CLEAR = 100,
  KP_MEMORY_RECALL = 101,
  KP_MEMORY_STORE = 102,
  KP_MEMORY_SUBTRACT = 103,
  KP_MULTIPLY = 104, // Keypad *
  KP_PAREN_LEFT = 105,
  KP_PAREN_RIGHT = 106,
  KP_MINUS = 107, // Keypad -
  KP_SEPARATOR = 108,
  NUMPAD_UP = 109,
  NUMPAD_DOWN = 110,
  NUMPAD_RIGHT = 111,
  NUMPAD_LEFT = 112,
  NUMPAD_BEGIN = 113,
  NUMPAD_HOME = 114,
  NUMPAD_END = 115,
  NUMPAD_INSERT = 116,
  NUMPAD_DELETE = 117,
  NUMPAD_PAGE_UP = 118,
  NUMPAD_PAGE_DOWN = 119,

  // Function Keys
  ESCAPE = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  F25 = 145,
  FN = 146,
  FN_LOCK = 147,
  PRINT_SCREEN = 148,
  SCROLL_LOCK = 149,
  PAUSE = 150,

  // Media Keys
  BROWSER_BACK = 151,
  BROWSER_FAVORITES = 152,
  BROWSER_FORWARD = 153,
  BROWSER_HOME = 154,
  BROWSER_REFRESH = 155,
  BROWSER_SEARCH = 156,
  BROWSER_STOP = 157,
  EJECT = 158,
  LAUNCH_APP_1 = 159,
  LAUNCH_APP_2 = 160,
  LAUNCH_MAIL = 161,
  MEDIA_PLAY_PAUSE = 162,
  MEDIA_SELECT = 163,
  MEDIA_STOP = 164,
  MEDIA_TRACK_NEXT = 165,
  MEDIA_TRACK_PREVIOUS = 166,
  POWER = 167,
  SLEEP = 168,
  AUDIO_VOLUME_DOWN = 169,
  AUDIO_VOLUME_MUTE = 170,
  AUDIO_VOLUME_UP = 171,
  WAKE_UP = 172,

  // Clipboard Keys
  COPY = 173,
  CUT = 174,
  PASTE = 175,
}

/**
 * Modifier keys
 */
export enum Mods {
  NONE = 0,
  SHIFT = 1 << 0,
  CTRL = 1 << 1,
  ALT = 1 << 2,
  SUPER = 1 << 3, // Windows/Command key
  CAPSLOCK = 1 << 4,
  NUMLOCK = 1 << 5,
}

/**
 * Key event structure
 */
export interface KeyEvent {
  action: KeyAction;
  key: Key;
  mods: Mods;
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;
  unshiftedCodepoint?: number;
}

// ============================================================================
// WASM Exports Interface
// ============================================================================

/**
 * The libghostty-vt exports the bindings use (include/ghostty/vt/*.h).
 *
 * In wasm32, pointers, size_t, enums and bools are i32 and reach JS as signed
 * numbers: read pointers with `>>> 0`. A struct passed by value is passed as a
 * pointer to a copy, and u64 values (raw rows, raw cells) are BigInts.
 */
export interface GhosttyWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;

  // Memory and ABI (wasm.h, types.h)
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(slot: number): void;
  ghostty_wasm_take_opaque(slot: number): number;

  // Terminal (terminal.h)
  ghostty_terminal_new(allocator: number, outTerminal: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ): number;
  ghostty_terminal_set(terminal: number, option: number, value: number): number;
  ghostty_terminal_get(terminal: number, data: number, out: number): number;
  ghostty_terminal_vt_write(terminal: number, data: number, len: number): void;
  ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
  ghostty_terminal_grid_ref(terminal: number, point: number, outRef: number): number;

  // Grid references (grid_ref.h, screen.h)
  ghostty_grid_ref_cell(ref: number, outCell: number): number;
  ghostty_grid_ref_row(ref: number, outRow: number): number;
  ghostty_grid_ref_graphemes(ref: number, buf: number, bufLen: number, outLen: number): number;
  ghostty_grid_ref_hyperlink_uri(ref: number, buf: number, bufLen: number, outLen: number): number;
  ghostty_grid_ref_style(ref: number, outStyle: number): number;
  ghostty_row_get(row: bigint, data: number, out: number): number;

  // Render state (render.h)
  ghostty_render_state_new(allocator: number, outState: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, outIterator: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_get(iterator: number, data: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, outCells: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;

  // Key encoding (key/encoder.h, key/event.h)
  ghostty_key_encoder_new(allocator: number, outEncoder: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_key_encoder_setopt_from_terminal(encoder: number, terminal: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    outBuf: number,
    outBufSize: number,
    outLen: number
  ): number;
  ghostty_key_event_new(allocator: number, outEvent: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
  ghostty_key_event_set_composing(event: number, composing: number): void;
  ghostty_key_event_set_utf8(event: number, utf8: number, len: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;
}

// ============================================================================
// Terminal Types
// ============================================================================

/**
 * Dirty state from RenderState
 */
export enum DirtyState {
  NONE = 0,
  PARTIAL = 1,
  FULL = 2,
}

/**
 * Cursor state. The renderer draws the cursor at its viewport position, which
 * is -1 while the viewport is scrolled away from it.
 */
export interface RenderStateCursor {
  /** Column in the active area (the bottom screenful). */
  x: number;
  /** Row in the active area. */
  y: number;
  /** Column in the viewport, or -1 when the cursor is not on screen. */
  viewportX: number;
  /** Row in the viewport, or -1 when the cursor is not on screen. */
  viewportY: number;
  /** Visible per the terminal modes (DECTCEM). */
  visible: boolean;
  /** Blinking per the terminal modes (DECSCUSR, mode 12). */
  blinking: boolean;
  /** Shape per DECSCUSR, or the configured default. */
  style: 'block' | 'underline' | 'bar' | 'block_hollow';
}

/**
 * The terminal's current default colors (OSC 10/11/12 overrides included).
 */
export interface RenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB | null;
}

/**
 * Terminal configuration. Colors are 0xRRGGBB; omitted ones keep
 * libghostty-vt's defaults.
 */
export interface GhosttyTerminalConfig {
  /**
   * Scrollback lines to keep (0 keeps none). Approximate: libghostty-vt prunes
   * a page at a time, so a little more is kept.
   */
  scrollbackLimit?: number;
  fgColor?: number;
  bgColor?: number;
  cursorColor?: number;
  /** The 16 ANSI colors; undefined entries keep the default palette's. */
  palette?: (number | undefined)[];
  /** Cursor shape restored by DECSCUSR 0 (default: block). */
  cursorStyle?: 'block' | 'underline' | 'bar';
  /** Whether that default cursor blinks (default: false). */
  cursorBlink?: boolean;
}

/**
 * Opaque terminal pointer (WASM memory address)
 */
export type TerminalHandle = number;

/**
 * A terminal cell with its colors resolved (palette and defaults applied).
 */
export interface GhosttyCell {
  codepoint: number; // First codepoint of the grapheme (0 = empty)
  fg_r: number; // Foreground red
  fg_g: number; // Foreground green
  fg_b: number; // Foreground blue
  bg_r: number; // Background red
  bg_g: number; // Background green
  bg_b: number; // Background blue
  flags: number; // CellFlags
  width: number; // 1 = normal, 2 = wide, 0 = the spacer after a wide character
  hyperlink_id: number; // 1 inside an OSC 8 hyperlink, else 0 (get the URI by position)
  grapheme_len: number; // Codepoints beyond the first (combining marks, ZWJ sequences)
}

/**
 * RGB color
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Cell style flags (bitfield)
 */
export enum CellFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  INVERSE = 1 << 4,
  INVISIBLE = 1 << 5,
  BLINK = 1 << 6,
  FAINT = 1 << 7,
}

/**
 * Cursor position and visibility
 */
export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

// ============================================================================
// Link Detection System
// ============================================================================

/**
 * Represents a coordinate in the terminal buffer
 */
export interface IBufferCellPosition {
  x: number; // Column (0-based)
  y: number; // Row (0-based, absolute buffer position)
}

/**
 * Represents a range in the terminal buffer
 * Can span multiple lines for wrapped links
 */
export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition; // Inclusive
}

/**
 * Represents a detected link in the terminal
 */
export interface ILink {
  /** The URL or text of the link */
  text: string;

  /** The range of the link in the buffer (may span multiple lines) */
  range: IBufferRange;

  /** Called when the link is activated (clicked with modifier) */
  activate(event: MouseEvent): void;

  /** Optional: called when mouse enters/leaves the link */
  hover?(isHovered: boolean, event?: MouseEvent): void;

  /** Optional: called to clean up resources */
  dispose?(): void;
}

/**
 * Provides link detection for a specific type of link
 * Examples: OSC 8 hyperlinks, URL regex detection
 */
export interface ILinkProvider {
  /**
   * Provide links for a given row
   * @param y Absolute row in buffer (0-based)
   * @param callback Called with detected links (or undefined if none)
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;

  /** Optional: called when terminal is disposed */
  dispose?(): void;
}

/**
 * Simplified buffer line interface for link providers
 */
export interface IBufferLine {
  /** Number of cells in this line */
  length: number;

  /** Get cell at position */
  getCell(x: number): IBufferCell;

  /** Get text content of the line */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/**
 * Simplified buffer cell interface for link providers
 */
export interface IBufferCell {
  /** Get the character codepoint */
  getCodepoint(): number;

  /** Get the hyperlink ID (0 = no link) */
  getHyperlinkId(): number;

  /** Get the width of the character (1 or 2 for wide chars) */
  getWidth(): number;

  /** Check if cell has specific flags */
  isBold(): boolean;
  isItalic(): boolean;
  isDim(): boolean;
}

/**
 * Simplified terminal buffer interface for link providers
 */
export interface IBuffer {
  /** Number of rows in the buffer (viewport + scrollback) */
  length: number;

  /** Get line at absolute buffer position */
  getLine(y: number): IBufferLine;
}

/**
 * Terminal buffer manager (active vs alternate screen)
 */
export interface IBufferManager {
  /** Currently active buffer */
  active: IBuffer;

  /** Normal screen buffer */
  normal: IBuffer;

  /** Alternate screen buffer (for fullscreen apps) */
  alternate: IBuffer;
}

/**
 * Event system interface (xterm.js compatible)
 */
export type IEvent<T> = (listener: (data: T) => void) => IDisposable;

export interface IDisposable {
  dispose(): void;
}

/**
 * Event emitter for custom events
 */
export class EventEmitter<T> {
  private listeners: Array<(data: T) => void> = [];

  /** Subscribe to events */
  public readonly event: IEvent<T> = (listener: (data: T) => void): IDisposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  /** Emit an event to all listeners */
  public fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  /** Remove all listeners */
  public dispose(): void {
    this.listeners = [];
  }
}
