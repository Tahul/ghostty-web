# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~600KB WASM bundle
- GPU rendering with WebGL2, Canvas2D when WebGL2 isn't there

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a loopback-only HTTP server with a real shell on `http://127.0.0.1:8080`. The demo protects `/ws` with a per-run same-origin token and rejects cross-origin WebSocket handshakes. Works best on Linux and macOS.

  To intentionally bind somewhere else, set `HOST=<host>`. If you serve the demo through extra hostnames or a wildcard bind such as `HOST=0.0.0.0`, also set `GHOSTTY_ALLOWED_HOSTS=host1,host2`. Avoid remote exposure unless you understand the risk: the demo starts a real local shell.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

### Links

OSC 8 hyperlinks and plain-text URLs (including URLs soft-wrapped across rows) are detected automatically. By default they open in a new tab on Ctrl/Cmd+click. Pass a `linkHandler` (same shape as xterm.js) to route them yourself; it is called on every click, whatever the modifiers, and can be set or replaced after `open()`:

```javascript
term.options.linkHandler = {
  activate(event, uri, range) {
    openInAppBrowser(uri);
  },
  hover(event, uri, range) {}, // optional
  leave(event, uri, range) {}, // optional
};
```

Custom providers registered with `registerLinkProvider` are unaffected.

### Mouse

When the running program enables mouse tracking (vim, `less --mouse`, htop, tmux...), mouse and wheel input go to the program only: the wheel doesn't scroll the viewport and dragging doesn't select text. Hold **Shift** to bypass it: Shift+drag selects, Shift+wheel scrolls the scrollback, and nothing is reported to the program. Link clicks also require Shift while the program tracks the mouse.

### Rendering

Frames are drawn by the GPU through WebGL2: each cell is an instanced quad, glyphs come from a texture atlas rasterized once per glyph, and only the rows that changed are rebuilt and copied to the screen. All terminals on a page share one WebGL context (browsers cap them, 16 in Chrome) and one atlas per font. Without WebGL2 (or with software-only WebGL), and while a lost WebGL context is being restored, the same terminal draws with Canvas2D instead.

Either way, a frame is drawn only when something changed: output, a resize, scrolling, a selection or link-hover change, a cursor blink. An idle terminal draws no frames.

```javascript
const term = new Terminal({
  renderer: 'webgl', // default; 'canvas' always draws with Canvas2D
  customGlyphs: true, // default: box drawing & co. drawn as shapes, see below
  lowLatency: false, // true: desynchronized canvas, lower latency, may tear
});
```

These are read by `open()`. With `lowLatency`, the browser can show frames without waiting for the page compositor (`desynchronized` canvas), at the risk of tearing.

### Custom glyphs

Box drawing (U+2500-257F), block elements and shades (U+2580-259F), braille (U+2800-28FF) and Powerline triangles and half circles (U+E0B0-E0B7) are drawn as shapes on whole device pixels, so lines join across cells whatever the font and the pixel ratio. Set `customGlyphs: false` to draw them with the font.

`drawGlyph` draws other glyphs yourself (symbols the font lacks, icons). It gets a canvas context (scaled to CSS pixels), the cell, its box and its color, with the font and alpha already set; return `true` when it drew the glyph, `false` to fall back to the built-in drawing. It is read by `open()`:

```javascript
const term = new Terminal({
  drawGlyph(ctx, cell, x, y, width, height, color) {
    if (cell.codepoint !== 0xe0a0) return false; // Powerline branch symbol
    ctx.fillRect(x + width / 3, y + height / 4, width / 3, height / 2);
    return true;
  },
});
```

With WebGL, a glyph is drawn once (per codepoint, bold/italic and cell width), in white, and tinted per cell; glyphs drawn in other colors keep them. The drawing must therefore depend only on those, not on the cell's position or colors. With Canvas2D it is called for each non-blank cell drawn, except printable ASCII drawn in runs.

### Output and flow control

`write(data, callback)` parses small writes at once. Bigger ones are parsed in slices of about 8 ms between frames, so a flood of output never freezes the page; `callback` runs once `data` is parsed. Use it for backpressure: stop reading from the source while too much is in flight. The demo pauses its PTY above 512 KB unparsed and resumes below 128 KB, the client acknowledging every 32 KB parsed.

`scrollback` (default 10000) is a number of lines. The terminal drops scrollback a page at a time, so slightly fewer lines than that can be kept.

## Development

ghostty-web builds [libghostty-vt](https://mitchellh.com/writing/libghostty-is-coming), Ghostty's terminal core, to WebAssembly straight from upstream Ghostty (the `ghostty` submodule), with no patches. It drives its C API: the render state for drawing, grid references for scrollback, effects for query replies, bell, title and synchronized output.

> Requires Zig 0.16 and Bun.

```bash
bun run build
```

Mitchell Hashimoto (author of Ghostty) and the Ghostty team built libghostty-vt, which makes this all possible.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
