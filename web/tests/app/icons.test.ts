import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): Buffer => readFileSync(join(root, ...parts));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Color type lives in the IHDR chunk, which the spec pins as the first chunk of every PNG. */
const COLOR_TYPE = { rgb: 2, palette: 3, grayAlpha: 4, rgba: 6 } as const;

type PngHeader = { width: number; height: number; colorType: number };

function readPngHeader(png: Buffer): PngHeader {
  expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

/** A `tRNS` chunk reintroduces transparency even when the color type carries no alpha channel. */
function hasTransparencyChunk(png: Buffer): boolean {
  return png.includes(Buffer.from('tRNS', 'latin1'));
}

// iOS ignores the manifest `background_color` for a home-screen icon and composites transparent
// pixels onto white. Only a PNG with no alpha at all renders black there, so these icons must stay
// flattened — see also the OLED-only canvas asserted in tests/globals.test.ts.
describe('home-screen icons', () => {
  const opaque = [
    { path: ['app', 'apple-icon.png'], size: 180 },
    { path: ['public', 'android-chrome-192x192.png'], size: 192 },
    { path: ['public', 'android-chrome-512x512.png'], size: 512 },
  ];

  for (const { path, size } of opaque) {
    const name = path.join('/');

    it(`${name} is a ${size}x${size} PNG with no alpha channel`, () => {
      const png = read(...path);
      const header = readPngHeader(png);
      expect(header.width).toBe(size);
      expect(header.height).toBe(size);
      expect(header.colorType).toBe(COLOR_TYPE.rgb);
      expect(hasTransparencyChunk(png)).toBe(false);
    });
  }
});

// The favicon and the in-app mascot keep their alpha: browser tabs and the UI composite them over
// their own surfaces, so flattening them to black would paint a square behind the mascot.
describe('transparent icons', () => {
  const transparent = [
    { path: ['app', 'icon.png'], maxBytes: 200_000 },
    { path: ['public', 'icon.png'], maxBytes: 200_000 },
  ];

  for (const { path, maxBytes } of transparent) {
    const name = path.join('/');

    it(`${name} keeps transparency and stays under ${Math.round(maxBytes / 1000)} kB`, () => {
      const png = read(...path);
      const header = readPngHeader(png);
      expect(header.width).toBe(1024);
      expect(header.height).toBe(1024);
      expect([COLOR_TYPE.rgba, COLOR_TYPE.palette]).toContain(header.colorType);
      if (header.colorType === COLOR_TYPE.palette) expect(hasTransparencyChunk(png)).toBe(true);
      expect(png.byteLength).toBeLessThanOrEqual(maxBytes);
    });
  }
});

describe('web app manifest', () => {
  const manifest: unknown = JSON.parse(read('public', 'manifest.json').toString('utf-8'));

  const icons = (): ReadonlyArray<Record<string, unknown>> => {
    expect(manifest).toBeTypeOf('object');
    const list = (manifest as { icons?: unknown }).icons;
    expect(Array.isArray(list)).toBe(true);
    return list as ReadonlyArray<Record<string, unknown>>;
  };

  it('stays on the black OLED canvas', () => {
    expect(manifest).toMatchObject({ background_color: '#000000', theme_color: '#000000' });
  });

  it('declares every icon for both the plain and the maskable purpose', () => {
    const purposes = new Map<string, string[]>();
    for (const icon of icons()) {
      const src = String(icon.src);
      purposes.set(src, [...(purposes.get(src) ?? []), String(icon.purpose)]);
    }
    expect([...purposes.keys()].sort()).toEqual(['/android-chrome-192x192.png', '/android-chrome-512x512.png']);
    for (const declared of purposes.values()) expect(declared.sort()).toEqual(['any', 'maskable']);
  });
});
