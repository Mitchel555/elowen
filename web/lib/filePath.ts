// Shared path helpers for repo-relative file paths (task changes, timeline, project file editor).
// baseName/dirName split a path for display; extOf derives the lowercased file extension.

/** The file name — the segment after the last slash (the whole path when there's no slash). */
export const baseName = (p: string): string => p.split('/').pop() ?? p;

/** The directory prefix including its trailing slash, or '' when the path has no directory. */
export const dirName = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
};

/** The lowercased extension of the file name ('' when it has none). Splits on the file name's own
 *  last dot only — a dot in a directory segment is not an extension dot. */
export const extOf = (p: string): string => p.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
