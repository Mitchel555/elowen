// Loading generated images off disk for upload, shared by every platform adapter. The image-gen/image-edit
// plugins write their PNGs into their own data dirs, which are the adapters' data-dir siblings; an adapter
// only knows the file names extracted from the reply text.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Load up to `cap` images by name from `imageDirs` (first directory holding the name wins). A missing or
 *  unreadable file is skipped silently — the text still goes out without it. Names must already be
 *  validated by the caller; this joins them onto a path. */
export function resolveImageFiles(imageDirs, names, cap) {
  const files = [];
  for (const name of names.slice(0, cap)) {
    for (const dir of imageDirs) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      try { files.push({ name, data: readFileSync(p) }); } catch { /* unreadable → skip */ }
      break;
    }
  }
  return files;
}
