/**
 * Box drawing, block elements, shades, braille and Powerline symbols drawn as
 * shapes that fill their cell, the way native terminals draw them: font glyphs
 * for these leave gaps between cells and differ from font to font. The line
 * geometry follows Ghostty's sprite font (src/font/sprite/draw/box.zig).
 *
 * Shapes are laid out in whole device pixels so lines meet across cells.
 */

const NONE = 0;
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;

/**
 * Box drawing U+2500-U+257F. Lines: the weight of the up, right, down and left
 * arms (0 none, 1 light, 2 heavy, 3 double). Dashed lines: `d`, `h` or `v`, the
 * weight and the dash count. `a`: rounded corner, `x`: diagonal.
 */
// prettier-ignore
const BOX = [
  '0101', '0202', '1010', '2020', 'dh13', 'dh23', 'dv13', 'dv23', // 2500 ─ ━ │ ┃ ┄ ┅ ┆ ┇
  'dh14', 'dh24', 'dv14', 'dv24', '0110', '0210', '0120', '0220', // 2508 ┈ ┉ ┊ ┋ ┌ ┍ ┎ ┏
  '0011', '0012', '0021', '0022', '1100', '1200', '2100', '2200', // 2510 ┐ ┑ ┒ ┓ └ ┕ ┖ ┗
  '1001', '1002', '2001', '2002', '1110', '1210', '2110', '1120', // 2518 ┘ ┙ ┚ ┛ ├ ┝ ┞ ┟
  '2120', '2210', '1220', '2220', '1011', '1012', '2011', '1021', // 2520 ┠ ┡ ┢ ┣ ┤ ┥ ┦ ┧
  '2021', '2012', '1022', '2022', '0111', '0112', '0211', '0212', // 2528 ┨ ┩ ┪ ┫ ┬ ┭ ┮ ┯
  '0121', '0122', '0221', '0222', '1101', '1102', '1201', '1202', // 2530 ┰ ┱ ┲ ┳ ┴ ┵ ┶ ┷
  '2101', '2102', '2201', '2202', '1111', '1112', '1211', '1212', // 2538 ┸ ┹ ┺ ┻ ┼ ┽ ┾ ┿
  '2111', '1121', '2121', '2112', '2211', '1122', '1221', '2212', // 2540 ╀ ╁ ╂ ╃ ╄ ╅ ╆ ╇
  '1222', '2122', '2221', '2222', 'dh12', 'dh22', 'dv12', 'dv22', // 2548 ╈ ╉ ╊ ╋ ╌ ╍ ╎ ╏
  '0303', '3030', '0310', '0130', '0330', '0013', '0031', '0033', // 2550 ═ ║ ╒ ╓ ╔ ╕ ╖ ╗
  '1300', '3100', '3300', '1003', '3001', '3003', '1310', '3130', // 2558 ╘ ╙ ╚ ╛ ╜ ╝ ╞ ╟
  '3330', '1013', '3031', '3033', '0313', '0131', '0333', '1303', // 2560 ╠ ╡ ╢ ╣ ╤ ╥ ╦ ╧
  '3101', '3303', '1313', '3131', '3333', 'a', 'a', 'a',          // 2568 ╨ ╩ ╪ ╫ ╬ ╭ ╮ ╯
  'a', 'x', 'x', 'x', '0001', '1000', '0100', '0010',             // 2570 ╰ ╱ ╲ ╳ ╴ ╵ ╶ ╷
  '0002', '2000', '0200', '0020', '0201', '1020', '0102', '2010', // 2578 ╸ ╹ ╺ ╻ ╼ ╽ ╾ ╿
];

/** Whether drawCustomGlyph() draws this codepoint. */
export function isCustomGlyph(codepoint: number): boolean {
  return (
    (codepoint >= 0x2500 && codepoint <= 0x259f) || // box drawing, block elements, shades
    (codepoint >= 0x2800 && codepoint <= 0x28ff) || // braille
    (codepoint >= 0xe0b0 && codepoint <= 0xe0b7) // Powerline
  );
}

/**
 * Draws `codepoint` filling the cell box (x, y, width, height) in `color`.
 * `pixel` is the size of a device pixel in context units (1/devicePixelRatio
 * on a context scaled to CSS pixels): the box is snapped to device pixels, so
 * neighbouring cells share their edges exactly. Returns false, drawing
 * nothing, for codepoints it doesn't handle. Leaves the context as it found it.
 */
export function drawCustomGlyph(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  pixel: number = 1
): boolean {
  if (!isCustomGlyph(codepoint)) return false;
  const left = Math.round(x / pixel);
  const top = Math.round(y / pixel);
  const W = Math.max(1, Math.round((x + width) / pixel) - left);
  const H = Math.max(1, Math.round((y + height) / pixel) - top);
  // Line thickness, ~1/16 of the cell height: 1px at 1x, 2px at 2x
  const light = Math.max(1, Math.round(H / 16));

  ctx.save();
  try {
    // From here on, units are device pixels from the cell's top-left corner
    ctx.translate(left * pixel, top * pixel);
    ctx.scale(pixel, pixel);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (codepoint <= 0x257f) {
      drawBox(ctx, codepoint, W, H, light);
    } else if (codepoint <= 0x259f) {
      drawBlock(ctx, codepoint, W, H);
    } else if (codepoint <= 0x28ff) {
      drawBraille(ctx, codepoint - 0x2800, W, H);
    } else {
      drawPowerline(ctx, codepoint, W, H, light);
    }
  } finally {
    ctx.restore();
  }
  return true;
}

/** Fills the box from (x0, y0) to (x1, y1), if not empty. */
function box(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

/** Half of a length, rounded down, never negative. */
function half(length: number): number {
  return Math.floor(Math.max(0, length) / 2);
}

/** Clips drawing to the cell: strokes and curves would spill into neighbours. */
function clipToCell(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
}

// ============================================================================
// Box drawing
// ============================================================================

function drawBox(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  W: number,
  H: number,
  light: number
): void {
  const spec = BOX[codepoint - 0x2500];
  if (spec[0] === 'd') {
    const thickness = spec[2] === '2' ? 2 * light : light;
    drawDashes(ctx, spec[1] === 'h', Number(spec[3]), W, H, thickness, Math.max(4, light));
  } else if (spec === 'a') {
    drawArc(ctx, codepoint, W, H, light);
  } else if (spec === 'x') {
    drawDiagonals(ctx, codepoint, W, H, light);
  } else {
    drawLines(ctx, W, H, light, +spec[0], +spec[1], +spec[2], +spec[3]);
  }
}

/**
 * Lines from the cell center to its edges. Arms stop where they meet the
 * lines they join, double lines turn at their inner and outer rails.
 */
function drawLines(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  light: number,
  up: number,
  right: number,
  down: number,
  left: number
): void {
  const heavy = 2 * light;

  // Horizontal strokes, top to bottom: light, heavy, and the double rails
  // around the light stroke (the light stroke is the gap between them)
  const hLightTop = half(H - light);
  const hLightBottom = hLightTop + light;
  const hHeavyTop = half(H - heavy);
  const hHeavyBottom = hHeavyTop + heavy;
  const hDoubleTop = Math.max(0, hLightTop - light);
  const hDoubleBottom = hLightBottom + light;
  // Vertical strokes, left to right
  const vLightLeft = half(W - light);
  const vLightRight = vLightLeft + light;
  const vHeavyLeft = half(W - heavy);
  const vHeavyRight = vHeavyLeft + heavy;
  const vDoubleLeft = Math.max(0, vLightLeft - light);
  const vDoubleRight = vLightRight + light;

  const upBottom =
    left === HEAVY || right === HEAVY
      ? hHeavyBottom
      : left !== right || down === up
        ? left === DOUBLE || right === DOUBLE
          ? hDoubleBottom
          : hLightBottom
        : left === NONE && right === NONE
          ? hLightBottom
          : hLightTop;
  const downTop =
    left === HEAVY || right === HEAVY
      ? hHeavyTop
      : left !== right || up === down
        ? left === DOUBLE || right === DOUBLE
          ? hDoubleTop
          : hLightTop
        : left === NONE && right === NONE
          ? hLightTop
          : hLightBottom;
  const leftRight =
    up === HEAVY || down === HEAVY
      ? vHeavyRight
      : up !== down || left === right
        ? up === DOUBLE || down === DOUBLE
          ? vDoubleRight
          : vLightRight
        : up === NONE && down === NONE
          ? vLightRight
          : vLightLeft;
  const rightLeft =
    up === HEAVY || down === HEAVY
      ? vHeavyLeft
      : up !== down || right === left
        ? up === DOUBLE || down === DOUBLE
          ? vDoubleLeft
          : vLightLeft
        : up === NONE && down === NONE
          ? vLightLeft
          : vLightRight;

  if (up === LIGHT) box(ctx, vLightLeft, 0, vLightRight, upBottom);
  if (up === HEAVY) box(ctx, vHeavyLeft, 0, vHeavyRight, upBottom);
  if (up === DOUBLE) {
    box(ctx, vDoubleLeft, 0, vLightLeft, left === DOUBLE ? hLightTop : upBottom);
    box(ctx, vLightRight, 0, vDoubleRight, right === DOUBLE ? hLightTop : upBottom);
  }

  if (right === LIGHT) box(ctx, rightLeft, hLightTop, W, hLightBottom);
  if (right === HEAVY) box(ctx, rightLeft, hHeavyTop, W, hHeavyBottom);
  if (right === DOUBLE) {
    box(ctx, up === DOUBLE ? vLightRight : rightLeft, hDoubleTop, W, hLightTop);
    box(ctx, down === DOUBLE ? vLightRight : rightLeft, hLightBottom, W, hDoubleBottom);
  }

  if (down === LIGHT) box(ctx, vLightLeft, downTop, vLightRight, H);
  if (down === HEAVY) box(ctx, vHeavyLeft, downTop, vHeavyRight, H);
  if (down === DOUBLE) {
    box(ctx, vDoubleLeft, left === DOUBLE ? hLightBottom : downTop, vLightLeft, H);
    box(ctx, vLightRight, right === DOUBLE ? hLightBottom : downTop, vDoubleRight, H);
  }

  if (left === LIGHT) box(ctx, 0, hLightTop, leftRight, hLightBottom);
  if (left === HEAVY) box(ctx, 0, hHeavyTop, leftRight, hHeavyBottom);
  if (left === DOUBLE) {
    box(ctx, 0, hDoubleTop, up === DOUBLE ? vLightLeft : leftRight, hLightTop);
    box(ctx, 0, hLightBottom, down === DOUBLE ? vLightLeft : leftRight, hDoubleBottom);
  }
}

/**
 * `count` dashes with a gap after each and half gaps at both ends, so dashed
 * lines tile evenly across cells. Too short for that: a solid line.
 */
function drawDashes(
  ctx: CanvasRenderingContext2D,
  horizontal: boolean,
  count: number,
  W: number,
  H: number,
  thickness: number,
  desiredGap: number
): void {
  const length = horizontal ? W : H;
  const dash = (start: number, end: number) => {
    if (horizontal) box(ctx, start, half(H - thickness), end, half(H - thickness) + thickness);
    else box(ctx, half(W - thickness), start, half(W - thickness) + thickness, end);
  };
  if (length < 2 * count) {
    dash(0, length);
    return;
  }
  const gap = Math.min(desiredGap, Math.floor(length / (2 * count)));
  const dashLength = Math.floor((length - count * gap) / count);
  // Leftover pixels go to the dashes, where they show less than in gaps
  let extra = (length - count * gap) % count;
  let start = Math.floor(gap / 2);
  for (let i = 0; i < count; i++) {
    let end = start + dashLength;
    if (extra > 0) {
      extra--;
      end++;
    }
    dash(start, end);
    start = end + gap;
  }
}

/** Rounded corners ╭ ╮ ╯ ╰: a quarter circle joining two edge midpoints. */
function drawArc(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  W: number,
  H: number,
  light: number
): void {
  // The centers of the light strokes, which the arc continues
  const cx = half(W - light) + light / 2;
  const cy = half(H - light) + light / 2;
  const toBottom = codepoint === 0x256d || codepoint === 0x256e; // ╭ ╮
  const toRight = codepoint === 0x256d || codepoint === 0x2570; // ╭ ╰
  const radius = Math.min(W, H) / 2;
  clipToCell(ctx, W, H);
  ctx.lineWidth = light;
  ctx.beginPath();
  ctx.moveTo(cx, toBottom ? H : 0);
  ctx.arcTo(cx, cy, toRight ? W : 0, cy, radius);
  ctx.lineTo(toRight ? W : 0, cy);
  ctx.stroke();
}

/** ╱ ╲ ╳ from corner to corner. */
function drawDiagonals(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  W: number,
  H: number,
  light: number
): void {
  clipToCell(ctx, W, H);
  ctx.lineWidth = light;
  ctx.beginPath();
  if (codepoint !== 0x2572) {
    ctx.moveTo(W, 0);
    ctx.lineTo(0, H);
  }
  if (codepoint !== 0x2571) {
    ctx.moveTo(0, 0);
    ctx.lineTo(W, H);
  }
  ctx.stroke();
}

// ============================================================================
// Block elements and shades
// ============================================================================

/** Quadrant blocks ▖ ▗ ▘ ▙ ▚ ▛ ▜ ▝ ▞ ▟: upper left, upper right, lower left, lower right. */
const QUADRANTS = [
  [0, 0, 1, 0],
  [0, 0, 0, 1],
  [1, 0, 0, 0],
  [1, 0, 1, 1],
  [1, 0, 0, 1],
  [1, 1, 1, 0],
  [1, 1, 0, 1],
  [0, 1, 0, 0],
  [0, 1, 1, 0],
  [0, 1, 1, 1],
];

function drawBlock(ctx: CanvasRenderingContext2D, codepoint: number, W: number, H: number): void {
  const eighthsDown = (n: number) => Math.round((H * n) / 8);
  const eighthsAcross = (n: number) => Math.round((W * n) / 8);
  if (codepoint === 0x2580) {
    box(ctx, 0, 0, W, eighthsDown(4)); // ▀
  } else if (codepoint <= 0x2588) {
    box(ctx, 0, H - eighthsDown(codepoint - 0x2580), W, H); // ▁ lower 1/8 ... █ full
  } else if (codepoint <= 0x258f) {
    box(ctx, 0, 0, eighthsAcross(0x2590 - codepoint), H); // ▉ left 7/8 ... ▏ left 1/8
  } else if (codepoint === 0x2590) {
    box(ctx, eighthsAcross(4), 0, W, H); // ▐
  } else if (codepoint <= 0x2593) {
    // ░ ▒ ▓: the color at 1/4, 1/2 and 3/4 strength
    ctx.globalAlpha *= (codepoint - 0x2590) / 4;
    box(ctx, 0, 0, W, H);
  } else if (codepoint === 0x2594) {
    box(ctx, 0, 0, W, eighthsDown(1)); // ▔
  } else if (codepoint === 0x2595) {
    box(ctx, W - eighthsAcross(1), 0, W, H); // ▕
  } else {
    const [upperLeft, upperRight, lowerLeft, lowerRight] = QUADRANTS[codepoint - 0x2596];
    const midX = eighthsAcross(4);
    const midY = eighthsDown(4);
    if (upperLeft) box(ctx, 0, 0, midX, midY);
    if (upperRight) box(ctx, midX, 0, W, midY);
    if (lowerLeft) box(ctx, 0, midY, midX, H);
    if (lowerRight) box(ctx, midX, midY, W, H);
  }
}

// ============================================================================
// Braille
// ============================================================================

/** Braille dots 1-8 (bits 0-7) as [column, row] in the 2x4 grid. */
const BRAILLE_DOTS = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
];

function drawBraille(ctx: CanvasRenderingContext2D, pattern: number, W: number, H: number): void {
  const size = Math.max(1, Math.floor(Math.min(W / 4, H / 8)));
  for (let bit = 0; bit < 8; bit++) {
    if (!(pattern & (1 << bit))) continue;
    const [column, row] = BRAILLE_DOTS[bit];
    const x = Math.round((W * (2 * column + 1)) / 4 - size / 2);
    const y = Math.round((H * (2 * row + 1)) / 8 - size / 2);
    box(ctx, x, y, x + size, y + size);
  }
}

// ============================================================================
// Powerline
// ============================================================================

/** U+E0B0-E0B7: even codepoints are solid shapes, odd ones their outlines. */
function drawPowerline(
  ctx: CanvasRenderingContext2D,
  codepoint: number,
  W: number,
  H: number,
  light: number
): void {
  clipToCell(ctx, W, H);
  ctx.beginPath();
  switch (codepoint & ~1) {
    case 0xe0b0: // right-pointing triangle
      ctx.moveTo(0, 0);
      ctx.lineTo(W, H / 2);
      ctx.lineTo(0, H);
      break;
    case 0xe0b2: // left-pointing triangle
      ctx.moveTo(W, 0);
      ctx.lineTo(0, H / 2);
      ctx.lineTo(W, H);
      break;
    case 0xe0b4: // right half circle
      ctx.ellipse(0, H / 2, W, H / 2, 0, -Math.PI / 2, Math.PI / 2);
      break;
    default: // 0xe0b6: left half circle
      ctx.ellipse(W, H / 2, W, H / 2, 0, Math.PI / 2, (3 * Math.PI) / 2);
  }
  if (codepoint % 2 === 0) {
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.lineWidth = light;
    ctx.stroke();
  }
}
