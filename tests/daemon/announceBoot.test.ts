import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { announceBoot } from '../../src/daemon/bootstrap.js';
import type { BrainService } from '../../src/brain/brainService.js';

// announceBoot only ever calls notify() on the brain, so a one-method stand-in is the whole surface.
const fakeBrain = (sent: string[]): BrainService =>
  ({ notify: async (text: string) => { sent.push(text); } }) as unknown as BrainService;

describe('announceBoot — every boot is announced, not just an operator /restart', () => {
  let dir: string;
  let restartMarker: string;
  let bootMarker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-boot-'));
    restartMarker = join(dir, '.restart-marker');
    bootMarker = join(dir, '.boot-announce');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('announces an ordinary boot with the version, so an unexpected restart says WHICH build came up', async () => {
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('the daemon started (v9.9.9)');
  });

  it('confirms a user-triggered /restart in its own words, and consumes the marker', async () => {
    writeFileSync(restartMarker, String(Date.now()));
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent).toEqual(['✅ **Back online** — Elowen restarted and is ready.']);
    // Read once, ever: a marker left behind would make the NEXT boot claim to be this restart.
    expect(existsSync(restartMarker)).toBe(false);
  });

  it('treats a stale marker as an ordinary boot rather than a restart that never happened', async () => {
    writeFileSync(restartMarker, String(Date.now() - 10 * 60_000)); // older than the 5min window
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent[0]).toContain('the daemon started');
    expect(existsSync(restartMarker)).toBe(false);
  });

  it('goes quiet on a second boot inside the debounce, so a crash loop reports once and not forever', async () => {
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent).toHaveLength(1);
  });

  it('announces again once the debounce has passed', async () => {
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    writeFileSync(bootMarker, String(Date.now() - 120_000)); // last announcement two minutes ago
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent).toHaveLength(2);
  });

  it('confirms a /restart even inside the debounce — the operator explicitly asked and is waiting', async () => {
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    writeFileSync(restartMarker, String(Date.now()));
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('restarted and is ready');
  });

  it('stays silent without a state dir, which is how the in-memory test daemon never posts anywhere', async () => {
    const sent: string[] = [];
    await announceBoot(fakeBrain(sent), undefined, undefined, '9.9.9');
    expect(sent).toEqual([]);
  });

  it('survives an unwritable marker and an unreadable one rather than breaking startup', async () => {
    const sent: string[] = [];
    writeFileSync(restartMarker, 'not-a-timestamp');
    await announceBoot(fakeBrain(sent), restartMarker, bootMarker, '9.9.9');
    expect(sent[0]).toContain('the daemon started'); // unparseable → stale → ordinary boot
    expect(Number(readFileSync(bootMarker, 'utf8'))).toBeGreaterThan(0);
  });

  it('never lets a notify failure escape into startup', async () => {
    const exploding = ({ notify: async () => { throw new Error('discord is down'); } }) as unknown as BrainService;
    await expect(announceBoot(exploding, restartMarker, bootMarker, '9.9.9')).resolves.toBeUndefined();
  });
});
