/**
 * Colors for the GPU: CSS colors parsed to channels, packed as the bytes
 * r, g, b, a of a 32-bit word (the byte order WebGL reads them in on the
 * little-endian machines browsers run on).
 */

/** Red, green and blue 0-255, alpha 0-1. */
export type RGBA = readonly [r: number, g: number, b: number, a: number];

const parsed = new Map<string, RGBA>();
let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS color as channels. Hex forms are read directly, anything else
 * (names, rgb(), hsl()...) through a canvas, which normalizes them. Unknown
 * colors are opaque black.
 */
export function parseCssColor(color: string): RGBA {
  let rgba = parsed.get(color);
  if (rgba) return rgba;
  rgba = parseHex(color) ?? parseWithCanvas(color) ?? [0, 0, 0, 1];
  parsed.set(color, rgba);
  return rgba;
}

function parseHex(color: string): RGBA | null {
  const match = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const value = Number.parseInt(hex.slice(0, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, alpha];
}

function parseWithCanvas(color: string): RGBA | null {
  if (probe === undefined) {
    probe =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!probe) return null;
  // An invalid color leaves fillStyle unchanged: start from a sentinel
  probe.fillStyle = '#010203';
  probe.fillStyle = color;
  const normalized = String(probe.fillStyle);
  if (normalized === '#010203') return null;
  return parseHex(normalized) ?? parseRgbFunction(normalized);
}

function parseRgbFunction(color: string): RGBA | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    color
  );
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

/** Packs straight (not premultiplied) channels, r, g, b and a all 0-255. */
export function packColor(r: number, g: number, b: number, a: number): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

/** Packs a color premultiplied by its alpha (0-1, times `alpha`), for blending. */
export function packPremultiplied(rgba: RGBA, alpha: number = 1): number {
  const a = rgba[3] * alpha;
  return packColor(
    Math.round(rgba[0] * a),
    Math.round(rgba[1] * a),
    Math.round(rgba[2] * a),
    Math.round(a * 255)
  );
}

/** `top` drawn over `bottom`, both premultiplied and packed. */
export function overPremultiplied(top: number, bottom: number): number {
  const keep = 1 - (top >>> 24) / 255;
  const channel = (shift: number) =>
    Math.min(255, ((top >>> shift) & 0xff) + Math.round(((bottom >>> shift) & 0xff) * keep));
  return packColor(channel(0), channel(8), channel(16), channel(24));
}

/** 0xRRGGBB as an opaque packed color. */
export function packRgb(rgb: number): number {
  return packColor((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, 255);
}
