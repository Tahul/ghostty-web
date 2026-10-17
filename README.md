# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

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

The canvas is redrawn only when something changed: output, a resize, scrolling, a selection or link-hover change, a cursor blink. An idle terminal draws no frames. Only changed rows are redrawn; printable ASCII of one style is drawn one run per `fillText`, with ligatures and kerning off so it matches cell-by-cell drawing.

### Custom glyphs

`drawGlyph` draws glyphs the font should not, such as box drawing that must fill its cell. It gets the canvas context (scaled to CSS pixels), the cell, its box and its color, with the font and alpha already set; return `true` when it drew the glyph, `false` to fall back to text. It is not called for blank cells nor for printable ASCII drawn in runs, and is read by `open()`:

```javascript
const term = new Terminal({
  drawGlyph(ctx, cell, x, y, width, height, color) {
    if (cell.codepoint !== 0x2500) return false; // ─
    ctx.fillRect(x, y + height / 2, width, 1);
    return true;
  },
});
```

## Development

ghostty-web builds from Ghostty's source with a [patch](./patches/ghostty-wasm-api.patch) to expose additional
functionality.

> Requires Zig and Bun.

```bash
bun run build
```

Mitchell Hashimoto (author of Ghostty) has [been working](https://mitchellh.com/writing/libghostty-is-coming) on `libghostty` which makes this all possible. The patches are very minimal thanks to the work the Ghostty team has done, and we expect them to get smaller.

This library will eventually consume a native Ghostty WASM distribution once available, and will continue to provide an xterm.js compatible API.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
