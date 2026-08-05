/** Shrinking an attached image in the browser before it is sent.
 *
 *  A photo taken on a phone is routinely 3–12 MB and several thousand pixels wide, which is over the
 *  5 MB the vision providers accept — so the attachment was simply refused and there was nothing the
 *  user could do about it from a phone. Sending the full resolution would be wasteful even if it fit:
 *  Anthropic downscales anything past ~1568px on the long edge server-side anyway, so the extra pixels
 *  cost bandwidth and tokens and buy nothing.
 *
 *  Everything here is a no-op when the browser APIs are missing (jsdom, an old engine): the caller then
 *  behaves exactly as it did before, refusing what it cannot shrink. */

/** Longest edge worth sending — the point past which the provider resizes it anyway. */
export const MAX_IMAGE_EDGE = 1568;

/** Quality ladder for the re-encode. The first pass is visually lossless for a photo; the lower rungs
 *  only come into play if the result somehow still exceeds the byte budget. */
const QUALITY_STEPS = [0.85, 0.7, 0.55];

/** Scale a size down so its longest edge fits `maxEdge`, preserving the aspect ratio. An image already
 *  within bounds is returned untouched — callers use that equality to skip re-encoding entirely. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width, height };
  const scale = maxEdge / longest;
  // Never round a dimension down to zero: a canvas of width 0 throws rather than producing a blob.
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** What the copy should be encoded as. A JPEG source is a photo and stays a JPEG; anything else may
 *  carry transparency, which JPEG would flatten to black, so it becomes WEBP — both are types the
 *  providers decode.
 *
 *  A type the providers do NOT decode (heic from an iPhone, avif, bmp) is converted rather than refused:
 *  the engine that took the photo can generally decode it even though the provider cannot, and on a phone
 *  converting it by hand is not something a user can do. When the engine cannot decode it either, the
 *  decode below fails and the caller refuses it exactly as before.
 *
 *  An animated GIF is the one deliberate exception: a canvas keeps only its first frame, so shrinking one
 *  would silently throw the animation away. */
function targetType(sourceType: string): string | null {
  if (sourceType === 'image/gif') return null;
  if (sourceType === 'image/jpeg') return 'image/jpeg';
  return 'image/webp';
}

/** True when this image is worth shrinking: too many bytes for the provider, or more pixels than it
 *  will keep. */
export function shouldDownscale(size: number, maxBytes: number, width: number, height: number, maxEdge: number): boolean {
  return size > maxBytes || Math.max(width, height) > maxEdge;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null); // jsdom and old engines have no encoder
    }
  });
}

/** Produce a smaller copy of `file` that fits the provider's budget, or null when shrinking is not
 *  possible or not needed. Null is not a failure — the caller falls back to its previous behaviour. */
export async function downscaleImage(
  file: File,
  opts: { maxBytes: number; sourceType: string; maxEdge?: number; mustConvert?: boolean },
): Promise<{ blob: Blob; mimeType: string } | null> {
  const maxEdge = opts.maxEdge ?? MAX_IMAGE_EDGE;
  // The caller's resolved type, not `file.type`: a browser that reported no type at all still has its
  // real format worked out by extension, and shrinking must not be skipped just because of that.
  const type = targetType(opts.sourceType);
  if (!type) return null;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // undecodable here — let the caller refuse it with its own message
  }
  try {
    // `mustConvert` is set for a type the providers cannot decode: it has to be re-encoded whatever its
    // size, because leaving it alone means refusing it.
    if (!opts.mustConvert && !shouldDownscale(file.size, opts.maxBytes, bitmap.width, bitmap.height, maxEdge)) return null;
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, type, quality);
      if (!blob) return null;
      // A browser that cannot encode the requested type silently hands back a PNG, which would defeat
      // the whole point — only accept a blob that is actually what we asked for.
      if (blob.type !== type) return null;
      if (blob.size <= opts.maxBytes) return { blob, mimeType: type };
    }
    return null; // still too big even at the lowest rung
  } finally {
    bitmap.close();
  }
}
