/** Truncation for a delegated RESULT — the body a finished sub-agent or workflow node hands back.
 *
 *  A report puts its conclusion last, so an over-long one has to lose its HEAD, not its tail. A 12 894-char
 *  delegated report once reached its parent cut short and the only part anyone wanted — the conclusion —
 *  was the part destroyed. Claude Code truncates task output the same way (`output.slice(-availableSpace)`,
 *  src/utils/task/outputFormatting.ts:33-37).
 *
 *  Head-first clipping stays right for a PREVIEW (a snapshot line, a listing row): those show a beginning on
 *  purpose. This is only for the text a parent actually reads as the answer. */

/** The note a truncated result carries: that it happened, how much went, and how to get the rest. DelegateRead
 *  pages the child's whole stored text back out of the database, so nothing cut here is unrecoverable. */
const truncationNote = (dropped) =>
  `[truncated: first ${dropped} chars dropped, end kept — read it in full with DelegateRead]\n`;

/** Keep the LAST `limit` characters of an over-long result, announced by {@link truncationNote}. The note is
 *  counted inside the limit, so the output never exceeds it — an outer bound at the same ceiling (the store's
 *  own guard on the delivery path) then has nothing left to shave off the end just preserved. A limit too
 *  small to hold the note yields the note alone: a parent handed a fragment with no marker cannot tell it is
 *  reading one, so the marker is the last thing to go. */
export function clipTail(text, limit) {
  if (text.length <= limit) return text;
  // Size the slice against the LONGEST the note could be (every character dropped). The count it then states
  // is exact for the slice actually kept, so one pass settles both.
  const kept = Math.max(0, limit - truncationNote(text.length).length);
  // `slice(-0)` is `slice(0)` — the whole string — so a zero-width tail has to be spelled out.
  return `${truncationNote(text.length - kept)}${kept === 0 ? '' : text.slice(-kept)}`;
}
