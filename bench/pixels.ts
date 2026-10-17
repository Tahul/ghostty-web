/**
 * Pixel comparison of the renderer against the baseline copy in
 * bench/baseline (a checkout of the previous lib/), in a real browser:
 * `bun run dev`, then open http://localhost:8000/bench/pixels.html.
 */
import * as next from '../lib/index';
// @ts-ignore: temporary baseline copy
import * as base from './baseline/lib/index';

const theme = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' };

const content = [
  'plain ascii: The quick brown fox -> jumps != over === the <= lazy >= dog ffi fl www',
  '\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[1;3mbold italic\x1b[0m \x1b[2mfaint text\x1b[0m \x1b[4munder\x1b[0m \x1b[9mstrike\x1b[0m',
  '\x1b[31mred\x1b[32mgreen\x1b[33myellow\x1b[34mblue\x1b[0m \x1b[7minverse\x1b[0m \x1b[38;2;255;128;0mtruecolor\x1b[0m \x1b[48;5;236m bg 236 \x1b[0m',
  'true black bg: \x1b[48;2;0;0;0m  black  \x1b[0m end',
  'box ┌──┬──┐ │a │b │ └──┴──┘ ░▒▓█ ▀▄ ⠿ ●',
  'cjk 日本語テキスト emoji 🎉🚀 e\u0301 accents àéîõü',
  '\x1b[44m   spaces in blue   \x1b[0m    trailing    ',
  '  indented code: if (a && b) { return x => x * 2; } // comment',
].join('\r\n');

let runnable = '';

async function draw(
  mod: any,
  fontFamily: string,
  fontSize: number,
  batching: boolean | null
): Promise<ImageData> {
  const ghostty = await mod.Ghostty.load();
  const div = document.createElement('div');
  document.body.appendChild(div);
  const term = new mod.Terminal({ ghostty, cols: 90, rows: 10, fontFamily, fontSize, theme });
  term.open(div);
  term.cancelRenderLoop();
  if (batching === false) term.renderer.canBatchText = false;
  term.write(content);
  const ctx = term.renderer.ctx;
  let texts = 0;
  const fillText = ctx.fillText;
  ctx.fillText = (...args: unknown[]) => {
    texts++;
    return fillText.apply(ctx, args);
  };
  term.renderer.render(term.wasmTerm, true, 0, term, 0);
  ctx.fillText = fillText;
  if (batching) runnable = `${term.renderer.runnableFonts}, ${texts} fillText`;
  const canvas: HTMLCanvasElement = term.renderer.getCanvas();
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  term.dispose();
  return data;
}

function diff(a: ImageData, b: ImageData, rowHeight: number): string {
  if (a.width !== b.width || a.height !== b.height)
    return `size ${a.width}x${a.height} vs ${b.width}x${b.height}`;
  let count = 0;
  let maxDelta = 0;
  const rows = new Set<number>();
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
    if (delta > 0) {
      count++;
      maxDelta = Math.max(maxDelta, delta);
      rows.add(Math.floor(i / 4 / a.width / rowHeight));
    }
  }
  return `${count} px differ (max channel delta ${maxDelta}), rows [${[...rows].sort((x, y) => x - y).join(',')}]`;
}

async function main() {
  try {
    const fira = new FontFace(
      'Fira Code',
      'url(https://cdn.jsdelivr.net/npm/firacode@6.2.0/distr/woff2/FiraCode-Regular.woff2)'
    );
    document.fonts.add(await fira.load());
  } catch {
    // offline: the Fira Code row compares fallbacks
  }
  await next.init?.();
  const dpr = Number(new URLSearchParams(location.search).get('dpr') ?? devicePixelRatio);
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  const lines: string[] = [`dpr ${devicePixelRatio}`];
  for (const font of [
    'monospace',
    'Menlo',
    '"Hack Nerd Font Mono"',
    '"Fira Code"',
    '"Courier New"',
  ]) {
    for (const size of [13, 14, 15, 20]) {
      const old = await draw(base, font, size, null);
      const runs = await draw(next, font, size, true);
      const cells = await draw(next, font, size, false);
      const rowHeight = old.height / 10;
      lines.push(
        `${font} ${size}px (runs: ${runnable}): baseline vs new: ${diff(old, runs, rowHeight)}; per-cell vs runs: ${diff(cells, runs, rowHeight)}`
      );
    }
  }
  document.getElementById('out')!.textContent = lines.join('\n');
  (window as any).__pixels = lines;
  (window as any).__draw = (old: boolean, font: string, size: number) =>
    draw(old ? base : next, font, size, null);
}

main().catch((e) => {
  document.getElementById('out')!.textContent = String(e?.stack ?? e);
});
