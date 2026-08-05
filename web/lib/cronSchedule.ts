/** The web's cron-schedule grammar was merged into `./cron` (its parser is now the single web-side
 *  copy); this module is kept as the compatibility surface the settings UI and the cross-tree parity
 *  test import `isValidSchedule` from. The grammar still has two OTHER mirrors outside the web bundle:
 *  the daemon's `src/shared/cronSchedule.ts` and the plugin's `parseSchedule` in
 *  plugins/cronjob/index.mjs — keep those in lockstep with `./cron`. */
export { isValidSchedule } from './cron';
