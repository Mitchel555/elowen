import { describe, it, expect, afterEach, vi } from 'vitest';
import { fitWithin, shouldDownscale, downscaleImage, MAX_IMAGE_EDGE } from '../../lib/imageDownscale';

// A phone photo is bigger than the provider accepts and has more pixels than it keeps, so it is shrunk
// in the browser instead of being refused. The geometry is pure and pinned directly; the encode path is
// exercised against stand-ins for the browser APIs jsdom does not implement.

describe('fitWithin', () => {
  it('leaves an image that already fits completely alone', () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1568, 1000, 1568)).toEqual({ width: 1568, height: 1000 });
  });

  it('scales the long edge down to the limit and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 1568)).toEqual({ width: 1568, height: 1176 });
    expect(fitWithin(3024, 4032, 1568)).toEqual({ width: 1176, height: 1568 });
  });

  it('never rounds a dimension to zero — a zero-width canvas cannot encode', () => {
    expect(fitWithin(10000, 3, 1568).height).toBeGreaterThanOrEqual(1);
  });

  it('is unfazed by a degenerate size', () => {
    expect(fitWithin(0, 0, 1568)).toEqual({ width: 0, height: 0 });
  });
});

describe('shouldDownscale', () => {
  it('shrinks anything past the byte budget', () => {
    expect(shouldDownscale(6_000_000, 5_242_880, 800, 600, 1568)).toBe(true);
  });

  it('shrinks an oversized picture even when its bytes fit, since the provider drops the pixels anyway', () => {
    expect(shouldDownscale(400_000, 5_242_880, 4032, 3024, 1568)).toBe(true);
  });

  it('leaves a small image alone', () => {
    expect(shouldDownscale(400_000, 5_242_880, 800, 600, 1568)).toBe(false);
  });
});

/** Stand in for the two browser APIs jsdom lacks, so the encode path can be driven end to end. */
function stubBrowser(opts: { width: number; height: number; encoded: (type: string, quality: number) => Blob | null }) {
  const drawn: { width: number; height: number }[] = [];
  const asked: { type: string; quality: number }[] = [];
  let closed = false;
  vi.stubGlobal('createImageBitmap', async () => ({
    width: opts.width, height: opts.height, close: () => { closed = true; },
  }));
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ width: w, height: h }) }),
    toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => { asked.push({ type, quality }); cb(opts.encoded(type, quality)); },
  };
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
  return { drawn, asked, wasClosed: () => closed };
}

const blobOf = (size: number, type: string) => ({ size, type }) as Blob;
const fileOf = (size: number, type: string) => ({ size, type, name: 'x' }) as File;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('downscaleImage', () => {
  it('shrinks a phone photo to the long-edge limit and hands back the smaller blob', async () => {
    const stub = stubBrowser({ width: 4032, height: 3024, encoded: (type) => blobOf(900_000, type) });
    const out = await downscaleImage(fileOf(9_000_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' });
    expect(out).toEqual({ blob: blobOf(900_000, 'image/jpeg'), mimeType: 'image/jpeg' });
    expect(stub.drawn).toEqual([{ width: MAX_IMAGE_EDGE, height: 1176 }]);
  });

  it('re-encodes a png as webp, which keeps transparency where jpeg would blacken it', async () => {
    stubBrowser({ width: 4000, height: 4000, encoded: (type) => blobOf(500_000, type) });
    const out = await downscaleImage(fileOf(8_000_000, 'image/png'), { maxBytes: 5_242_880, sourceType: 'image/png' });
    expect(out?.mimeType).toBe('image/webp');
  });

  it('drops to a lower quality only while the result is still too heavy', async () => {
    const stub = stubBrowser({
      width: 4000, height: 3000,
      encoded: (type, quality) => blobOf(quality > 0.8 ? 6_000_000 : 1_000_000, type),
    });
    const out = await downscaleImage(fileOf(9_000_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' });
    expect(out?.blob.size).toBe(1_000_000);
    expect(stub.asked.map((a) => a.quality)).toEqual([0.85, 0.7]);
  });

  it('gives up rather than sending something still over budget', async () => {
    stubBrowser({ width: 4000, height: 3000, encoded: (type) => blobOf(9_000_000, type) });
    expect(await downscaleImage(fileOf(9_000_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' })).toBeNull();
  });

  it('refuses a blob the browser encoded as something else than asked for', async () => {
    stubBrowser({ width: 4000, height: 3000, encoded: () => blobOf(100_000, 'image/png') });
    expect(await downscaleImage(fileOf(9_000_000, 'image/png'), { maxBytes: 5_242_880, sourceType: 'image/png' })).toBeNull();
  });

  it('converts a type the providers cannot read but the engine can — an iPhone heic', async () => {
    stubBrowser({ width: 4032, height: 3024, encoded: (type) => blobOf(700_000, type) });
    const out = await downscaleImage(fileOf(3_000_000, 'image/heic'), {
      maxBytes: 5_242_880, sourceType: 'image/heic', mustConvert: true,
    });
    expect(out?.mimeType).toBe('image/webp');
  });

  it('converts such a file even when it is small — leaving it alone would mean refusing it', async () => {
    const stub = stubBrowser({ width: 600, height: 400, encoded: (type) => blobOf(50_000, type) });
    const out = await downscaleImage(fileOf(80_000, 'image/heic'), {
      maxBytes: 5_242_880, sourceType: 'image/heic', mustConvert: true,
    });
    expect(out?.mimeType).toBe('image/webp');
    expect(stub.drawn).toEqual([{ width: 600, height: 400 }]); // converted, not resized
  });

  it('leaves an animated gif alone — a canvas would keep only its first frame', async () => {
    stubBrowser({ width: 4000, height: 3000, encoded: (type) => blobOf(100_000, type) });
    expect(await downscaleImage(fileOf(9_000_000, 'image/gif'), { maxBytes: 5_242_880, sourceType: 'image/gif' })).toBeNull();
  });

  it('does nothing for an image that is already small enough', async () => {
    stubBrowser({ width: 800, height: 600, encoded: (type) => blobOf(1, type) });
    expect(await downscaleImage(fileOf(200_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' })).toBeNull();
  });

  it('shrinks by the resolved type even when the browser reported none', async () => {
    stubBrowser({ width: 4032, height: 3024, encoded: (type) => blobOf(900_000, type) });
    const out = await downscaleImage(fileOf(9_000_000, ''), { maxBytes: 5_242_880, sourceType: 'image/jpeg' });
    expect(out?.mimeType).toBe('image/jpeg');
  });

  it('releases the decoded bitmap whichever way it ends', async () => {
    const stub = stubBrowser({ width: 4000, height: 3000, encoded: (type) => blobOf(9_000_000, type) });
    await downscaleImage(fileOf(9_000_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' });
    expect(stub.wasClosed()).toBe(true);
  });

  it('stays out of the way when the engine cannot decode the file at all', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('nope'); });
    expect(await downscaleImage(fileOf(9_000_000, 'image/jpeg'), { maxBytes: 5_242_880, sourceType: 'image/jpeg' })).toBeNull();
  });
});
