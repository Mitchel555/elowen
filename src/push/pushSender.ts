import webpush from 'web-push';
import type { PushSubscriptionStore, PushSubscriptionRecord } from '../store/pushSubscriptionStore.js';
import type { PushPayload } from './messages.js';
import { logger } from '../shared/logger.js';

const log = logger('push-sender');

/** Delivers one push to one endpoint. Real impl wraps web-push; tests inject a fake. Throws on
 *  failure; a `{statusCode}` of 404/410 signals a dead endpoint to prune. */
export type Deliver = (rec: PushSubscriptionRecord, payload: string) => Promise<void>;

const realDeliver: Deliver = (rec, payload) =>
  webpush.sendNotification({ endpoint: rec.endpoint, keys: { p256dh: rec.p256dh, auth: rec.auth } }, payload).then(() => undefined);

/** Last-resort VAPID `sub`. Every push carries this as the address a push service can reach the
 *  operator at, and it must be REAL: Apple rejects the entire signed token with 403 BadJwtToken for a
 *  made-up one. That is how `mailto:push@elowen.local` silently broke every push to an Apple device for
 *  as long as it shipped — the send reported success on our side and simply never arrived. The project
 *  URL is the only address true for every installation, so it stands in until an operator sets theirs. */
const FALLBACK_CONTACT = 'https://github.com/dragocz95/elowen';

/** Resolve the contact to sign with, preferring what the operator configured.
 *
 *  An unreachable address is worse than no address at all here, because the failure is a silent 403
 *  rather than a validation error. So an instance URL is only borrowed when it is public: a private or
 *  loopback host would reproduce the original bug with a different string. */
export function vapidContact(configured?: string, instanceUrl?: string): string {
  const set = configured?.trim();
  if (set && (set.startsWith('https://') || set.startsWith('mailto:'))) return set;
  if (!instanceUrl?.startsWith('https://') || !URL.canParse(instanceUrl)) return FALLBACK_CONTACT;
  const host = new URL(instanceUrl).hostname;
  const reachable = host.includes('.') && !host.endsWith('.local') && !host.endsWith('.localhost') && !host.endsWith('.internal');
  return reachable ? instanceUrl : FALLBACK_CONTACT;
}

/** Sends web-push notifications to a set of users' devices. Resilient: a failed send is logged and
 *  skipped (never thrown), and a dead endpoint (404/410) is pruned so it isn't retried forever. */
export class PushSender {
  constructor(
    private subs: PushSubscriptionStore,
    private keys: () => { publicKey: string; privateKey: string } | null,
    private deliver: Deliver = realDeliver,
    private contact: () => { configured?: string; instanceUrl?: string } = () => ({}),
  ) {}

  async sendToUsers(userIds: number[], payload: PushPayload): Promise<void> {
    const keys = this.keys();
    if (!keys) return; // VAPID not configured → no-op (web push simply unavailable)
    const c = this.contact();
    webpush.setVapidDetails(vapidContact(c.configured, c.instanceUrl), keys.publicKey, keys.privateKey);
    const body = JSON.stringify(payload);
    // Deliver in parallel: a single slow/hung endpoint must not delay every later device by minutes
    // (the old sequential await did). allSettled so one rejection never aborts the batch.
    await Promise.allSettled(this.subs.listForUsers(userIds).map((rec) => this.sendOne(rec, body)));
  }

  private async sendOne(rec: PushSubscriptionRecord, body: string): Promise<void> {
    try {
      await this.deliver(rec, body);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) this.subs.remove(rec.endpoint); // gone → prune
      else log.error(`push send failed for endpoint (status ${code ?? '?'})`, e);
    }
  }
}
