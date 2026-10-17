import { describe, expect, test } from 'bun:test';
import { overPremultiplied, packColor, packPremultiplied, packRgb, parseCssColor } from './color';

/** The bytes r, g, b, a of a packed color. */
function bytes(color: number): number[] {
  return [...new Uint8Array(Uint32Array.of(color).buffer)];
}

describe('GPU colors', () => {
  test('parses hex colors of every length', () => {
    expect(parseCssColor('#abc')).toEqual([0xaa, 0xbb, 0xcc, 1]);
    expect(parseCssColor('#abcd')).toEqual([0xaa, 0xbb, 0xcc, 0xdd / 255]);
    expect(parseCssColor('#123456')).toEqual([0x12, 0x34, 0x56, 1]);
    expect(parseCssColor('#12345680')).toEqual([0x12, 0x34, 0x56, 0x80 / 255]);
  });

  test('parses rgb() and rgba(), and takes unknown colors as black', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5]);
    expect(parseCssColor('not a color')).toEqual([0, 0, 0, 1]);
  });

  test('packs channels as the bytes r, g, b, a', () => {
    expect(bytes(packColor(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
    expect(bytes(packRgb(0x102030))).toEqual([0x10, 0x20, 0x30, 255]);
    expect(bytes(packPremultiplied([255, 0, 100, 0.5]))).toEqual([128, 0, 50, 128]);
    expect(bytes(packPremultiplied([255, 255, 255, 1], 0.25))).toEqual([64, 64, 64, 64]);
  });

  test('composites premultiplied colors', () => {
    const halfRed = packPremultiplied([255, 0, 0, 0.5]);
    const blue = packPremultiplied([0, 0, 255, 1]);
    // Half is 128/255: a hair over, so a hair less of what is under shows
    expect(bytes(overPremultiplied(halfRed, blue))).toEqual([128, 0, 127, 255]);
    expect(overPremultiplied(blue, halfRed)).toBe(blue);
  });
});
