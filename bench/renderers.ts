/**
 * The WebGL and Canvas2D renderers side by side in a real browser: pixel
 * differences between them and what a frame costs each. `bun run dev`, then
 * open http://localhost:8000/bench/renderers.html (?dpr=1.5 forces a pixel
 * ratio, ?font=Menlo a font). Results also land in `window.__renderers`.
 */
import { Ghostty, Terminal } from '../lib/index';

type Kind = 'webgl' | 'canvas';

const params = new URLSearchParams(location.search);
const FONT = params.get('font') ?? 'monospace';
const SIZE = Number(params.get('size') ?? 15);
const THEME = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' };

const SAMPLE = [
  'plain ascii: The quick brown fox -> jumps != over === the <= lazy >= dog ffi fl www',
  '\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[1;3mbold italic\x1b[0m \x1b[2mfaint text\x1b[0m \x1b[4munder\x1b[0m \x1b[9mstrike\x1b[0m',
  '\x1b[31mred\x1b[32mgreen\x1b[33myellow\x1b[34mblue\x1b[0m \x1b[7minverse\x1b[0m \x1b[38;2;255;128;0mtruecolor\x1b[0m \x1b[48;5;236m bg 236 \x1b[0m',
  'box ┌──┬──┐ ╔══╦══╗ ╭──╮ ┏━━┓ ░▒▓█ ▀▄▌▐ ⠿⣿ ●',
  '    │a │b │ ║a ║b ║ │  │ ┃  ┃ ┄┄┈┈ ╱╲╳ ▖▗▘▙',
  '    └──┴──┘ ╚══╩══╝ ╰──╯ ┗━━┛ \ue0b0\ue0b1\ue0b2\ue0b3\ue0b4\ue0b6',
  'cjk 日本語テキスト emoji 🎉🚀 e\u0301 accents àéîõü',
  '\x1b[44m   spaces in blue   \x1b[0m    trailing    \x1b[4m   \x1b[0m',
  '  indented code: if (a && b) { return x => x * 2; } // comment',
].join('\r\n');

function screenful(cols: number, rows: number, seed: number): string {
  let out = '\x1b[H';
  for (let y = 0; y < rows; y++) {
    let line = '';
    while (line.length < cols * 1.5) {
      line += `\x1b[3${(y + seed) % 7}m${'word'.repeat(1 + ((line.length + seed) % 3))}\x1b[0m `;
      line += '\x1b[1mbold\x1b[0m \x1b[48;5;236mbg\x1b[0m ';
    }
    out += `\x1b[${y + 1};1H${line.slice(0, cols * 2)}\x1b[0m\x1b[K`;
  }
  return out;
}

async function open(ghostty: Ghostty, kind: Kind, cols: number, rows: number): Promise<Terminal> {
  const host = document.createElement('div');
  host.className = 'term';
  document.getElementById(kind)!.appendChild(host);
  const term = new Terminal({
    ghostty,
    cols,
    rows,
    renderer: kind,
    fontFamily: FONT,
    fontSize: SIZE,
    theme: THEME,
  });
  term.open(host);
  (term as any).cancelRenderLoop();
  return term;
}

function draw(term: Terminal, forceAll: boolean): void {
  (term as any).renderer.render((term as any).wasmTerm, forceAll, 0, term, 0);
}

function pixels(term: Terminal): ImageData {
  const canvas: HTMLCanvasElement = (term as any).renderer.getCanvas();
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

/** Pixels differing by more than `tolerance` in any channel, and a picture of where. */
function compare(a: ImageData, b: ImageData, rowHeight: number, tolerance: number) {
  if (a.width !== b.width || a.height !== b.height) {
    return { summary: `size ${a.width}x${a.height} vs ${b.width}x${b.height}`, image: null };
  }
  const image = new ImageData(a.width, a.height);
  let count = 0;
  let maxDelta = 0;
  const rows = new Set<number>();
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
    maxDelta = Math.max(maxDelta, delta);
    const shade = a.data[i] / 4;
    image.data.set(delta > tolerance ? [255, 0, 0, 255] : [shade, shade, shade, 255], i);
    if (delta > tolerance) {
      count++;
      rows.add(Math.floor(i / 4 / a.width / rowHeight));
    }
  }
  const total = a.width * a.height;
  const summary = `${count} of ${total} px differ by > ${tolerance} (${((100 * count) / total).toFixed(2)}%), max delta ${maxDelta}, rows [${[...rows].sort((x, y) => x - y).join(',')}]`;
  return { summary, image };
}

/** Average milliseconds of `step` over `runs` runs, after a warm-up. */
function time(runs: number, step: (i: number) => void): number {
  for (let i = 0; i < 5; i++) step(i);
  const start = performance.now();
  for (let i = 0; i < runs; i++) step(i);
  return (performance.now() - start) / runs;
}

/**
 * Frames per second, and the slowest frame interval, while `write` feeds the
 * terminal before each animation frame. Frames include GPU work when it falls
 * behind (the browser then delays animation frames).
 */
function fps(
  term: Terminal,
  seconds: number,
  write: (frame: number) => void
): Promise<{ fps: number; slowest: number }> {
  return new Promise((resolve) => {
    let frames = 0;
    let slowest = 0;
    let last = performance.now();
    const start = last;
    const tick = () => {
      const now = performance.now();
      slowest = Math.max(slowest, now - last);
      last = now;
      write(frames);
      draw(term, false);
      frames++;
      if (now - start < seconds * 1000) requestAnimationFrame(tick);
      else resolve({ fps: frames / ((now - start) / 1000), slowest });
    };
    requestAnimationFrame(tick);
  });
}

/** The GPU WebGL runs on (or why there is none). */
function gpuName(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'no WebGL2';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

async function main() {
  const dprParam = params.get('dpr');
  if (dprParam) {
    Object.defineProperty(window, 'devicePixelRatio', {
      value: Number(dprParam),
      configurable: true,
    });
  }
  const ghostty = await Ghostty.load();
  const lines: string[] = [`dpr ${devicePixelRatio}, font ${SIZE}px ${FONT}, GPU ${gpuName()}`];
  const results: Record<string, unknown> = {};

  // Pixels: the sample with a selection and the cursor, through both renderers
  const terms = {} as Record<Kind, Terminal>;
  for (const kind of ['canvas', 'webgl'] as Kind[]) {
    const term = await open(ghostty, kind, 92, 10);
    term.write(SAMPLE);
    term.select(2, 8, 14);
    draw(term, true);
    terms[kind] = term;
  }
  lines.push(`webgl renderer uses the GPU: ${(terms.webgl as any).renderer.usesGpu}`);
  const rowHeight = (terms.canvas as any).renderer.getCanvas().height / 10;
  const diff = compare(pixels(terms.canvas), pixels(terms.webgl), rowHeight, 48);
  lines.push(`canvas vs webgl: ${diff.summary}`);
  results.diff = diff.summary;
  if (diff.image) {
    const canvas = document.createElement('canvas');
    canvas.width = diff.image.width;
    canvas.height = diff.image.height;
    canvas.getContext('2d')!.putImageData(diff.image, 0, 0);
    document.getElementById('diff')!.appendChild(canvas);
  }

  // Frame costs (main thread; GPU work runs after)
  for (const kind of ['canvas', 'webgl'] as Kind[]) {
    const term = await open(ghostty, kind, 200, 60);
    const full = time(40, (i) => {
      term.write(screenful(200, 60, i));
      draw(term, true);
    });
    const writeOnly = time(40, (i) => term.write(screenful(200, 60, i)));
    const oneRow = time(200, (i) => {
      term.write(`\x1b[30;1H\x1b[3${i % 7}mtyping ${i}\x1b[0m`);
      draw(term, false);
    });
    const scroll = time(200, (i) => {
      term.write(`\x1b[60;1H\r\n\x1b[3${i % 7}mline ${i} ${'x'.repeat(150)}\x1b[0m`);
      draw(term, false);
    });
    const logTail = await fps(term, 2, (i) =>
      term.write(`\x1b[3${i % 7}m${'streaming output '.repeat(6)}${i}\x1b[0m\r\n`)
    );
    const repaint = await fps(term, 2, (i) => term.write(screenful(200, 60, i)));
    const line =
      `${kind} 200x60 main thread: full screen ${(full - writeOnly).toFixed(2)} ms/frame, ` +
      `one row ${oneRow.toFixed(3)} ms, scroll ${scroll.toFixed(2)} ms (writes included); ` +
      `log tail ${logTail.fps.toFixed(0)} fps (slowest ${logTail.slowest.toFixed(0)} ms), ` +
      `full repaints ${repaint.fps.toFixed(0)} fps (slowest ${repaint.slowest.toFixed(0)} ms)`;
    lines.push(line);
    results[kind] = { full: full - writeOnly, oneRow, scroll, logTail, repaint };
    term.dispose();
  }

  document.getElementById('out')!.textContent = lines.join('\n');
  (window as any).__renderers = { lines, results };
}

main().catch((e) => {
  document.getElementById('out')!.textContent = String(e?.stack ?? e);
  (window as any).__renderers = { error: String(e?.stack ?? e) };
});
