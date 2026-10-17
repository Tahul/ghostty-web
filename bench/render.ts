/**
 * Canvas2D renderer cost on the happy-dom canvas mock (`bun bench/render.ts`).
 *
 * The mock's drawing calls are no-ops, so the timings are the JS side of a
 * frame (cell parsing, run building, style strings); canvas calls are
 * counted instead. Measures a full redraw at 120x40 and 200x60, frames and
 * canvas calls while idle (cursor blink off and on), and write throughput.
 * The WebGL renderer needs a browser: see bench/renderers.html.
 */
import '../happydom';
import { Ghostty, Terminal } from '../lib';

type Counts = Record<string, number>;

/** Counts calls to the canvas context's drawing methods. */
function instrument(term: Terminal): Counts {
  const counts: Counts = {};
  const ctx = (term as any).renderer.ctx as Record<string, unknown>;
  for (const name of ['fillRect', 'clearRect', 'fillText', 'stroke']) {
    const original = ctx[name] as (...args: unknown[]) => unknown;
    counts[name] = 0;
    ctx[name] = (...args: unknown[]) => {
      counts[name]++;
      return original(...args);
    };
  }
  return counts;
}

function reset(counts: Counts): void {
  for (const key of Object.keys(counts)) counts[key] = 0;
}

/** A screen of colored, styled text, like a busy `ls --color` or a build log. */
function screenful(cols: number, rows: number): string {
  let out = '\x1b[H';
  for (let y = 0; y < rows; y++) {
    let line = '';
    while (line.length < cols * 1.5) {
      line += `\x1b[3${y % 7}m${'word'.repeat(1 + (line.length % 3))}\x1b[0m `;
      line += '\x1b[1mbold\x1b[0m \x1b[48;5;236mbg\x1b[0m ';
    }
    out += `\x1b[${y + 1};1H${line.slice(0, cols * 2)}\x1b[0m\x1b[K`;
  }
  return out;
}

const THEME = { background: '#1e1e1e', foreground: '#d4d4d4' };

/** Gives the mock context `textRendering`, as browsers have, so text can be drawn in runs. */
function withTextRendering(): () => void {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
    const ctx = (getContext as any).apply(this, args);
    if (ctx) ctx.textRendering = 'auto';
    return ctx;
  } as any;
  return () => {
    HTMLCanvasElement.prototype.getContext = getContext;
  };
}

function open(
  ghostty: Ghostty,
  cols: number,
  rows: number,
  cursorBlink = false,
  theme: Record<string, string> = {}
): Terminal {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new Terminal({ ghostty, cols, rows, cursorBlink, theme, renderer: 'canvas' });
  term.open(container);
  return term;
}

function fullRedraw(term: Terminal, iterations: number): number {
  const renderer = (term as any).renderer;
  const wasm = (term as any).wasmTerm;
  renderer.render(wasm, true, 0, term, 0);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) renderer.render(wasm, true, 0, term, 0);
  return (performance.now() - start) / iterations;
}

async function idle(ghostty: Ghostty, cursorBlink: boolean, scrolled = false): Promise<string> {
  const term = open(ghostty, 120, 40, cursorBlink);
  for (let i = 0; i < 3; i++) term.write(`${screenful(120, 40)}\r\n`);
  if (scrolled) term.scrollLines(-10);
  await new Promise((r) => setTimeout(r, 2000)); // past the scrollbar fade
  const renderer = (term as any).renderer;
  const render = renderer.render.bind(renderer);
  let frames = 0;
  renderer.render = (...args: unknown[]) => {
    frames++;
    return render(...args);
  };
  const counts = instrument(term);
  const ms = 2000;
  await new Promise((r) => setTimeout(r, ms));
  term.dispose();
  const perSec = (n: number) => ((n * 1000) / ms).toFixed(1);
  const calls = counts.fillRect + counts.clearRect + counts.fillText;
  const label = `blink ${cursorBlink ? 'on ' : 'off'}${scrolled ? ', scrolled up' : ''}`;
  return `idle 120x40 ${label}: ${perSec(frames)} renders/s, ${perSec(calls)} canvas calls/s`;
}

async function main() {
  const ghostty = await Ghostty.load();

  for (const variant of ['default', 'theme', 'theme+runs'] as const) {
    const restore = variant === 'theme+runs' ? withTextRendering() : () => {};
    for (const [cols, rows] of [
      [120, 40],
      [200, 60],
    ]) {
      const term = open(ghostty, cols, rows, false, variant === 'default' ? {} : THEME);
      term.write(screenful(cols, rows));
      const counts = instrument(term);
      const ms = fullRedraw(term, 200);
      reset(counts);
      (term as any).renderer.render((term as any).wasmTerm, true, 0, term, 0);
      console.log(
        `full redraw ${cols}x${rows} ${variant}: ${ms.toFixed(3)} ms, fillRect ${counts.fillRect}, fillText ${counts.fillText}`
      );
      term.dispose();
    }
    restore();
  }

  console.log(await idle(ghostty, false));
  console.log(await idle(ghostty, true));
  console.log(await idle(ghostty, false, true));

  const term = open(ghostty, 120, 40);
  (term as any).cancelRenderLoop();
  for (const chunk of [screenful(120, 40).repeat(4), screenful(120, 40).slice(0, 256)]) {
    const bytes = new TextEncoder().encode(chunk).length;
    let total = 0;
    const start = performance.now();
    while (performance.now() - start < 1000) {
      term.write(chunk);
      total += bytes;
    }
    const seconds = (performance.now() - start) / 1000;
    console.log(
      `write throughput: ${(total / seconds / 1e6).toFixed(1)} MB/s (string chunks of ${bytes} B)`
    );
  }
  term.dispose();
  process.exit(0);
}

main();
