import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstallInfo, readInstallInfo, serializeInstallInfo, type InstallArtifacts, type InstallInfo } from '../../src/cli/installInfo.js';

// Every test writes its own install.json into a fresh temp dir and passes the path explicitly —
// readInstallInfo(path) is injectable, so nothing here ever touches /etc or ~/.config.
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-install-info-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const path = (): string => join(dir, 'install.json');

/** The exact shape installs written before artifact tracking existed — only the five connection
 *  fields. This is what production boxes (incl. this one) have on disk today. */
const OLD_RECORD: Omit<InstallInfo, 'artifacts'> = {
  publicUrl: 'https://build.coresynth.io',
  mode: 'domain',
  serviceUser: 'www-data',
  daemonPort: 4400,
  webPort: 4500,
};

const fresh = (over: Partial<InstallArtifacts> = {}): InstallInfo =>
  buildInstallInfo(OLD_RECORD, {
    version: '0.27.79',
    installedAt: '2026-08-01T13:00:00.000Z',
    units: [
      { path: '/etc/systemd/system/elowen-daemon.service', enabled: true },
      { path: '/etc/systemd/system/elowen-web.service', enabled: true },
      { path: '/etc/systemd/system/elowen-update.service', enabled: false },
      { path: '/etc/systemd/system/elowen-update.timer', enabled: true },
    ],
    sudoers: true,
    proxy: { kind: 'nginx', vhostPath: '/etc/nginx/sites-available/elowen.conf', tls: true },
    serviceUserCreated: true,
    agentClis: ['claude', 'opencode'],
    ...over,
  });

describe('cli/installInfo backward compatibility', () => {
  it('reads a pre-artifacts install.json without crashing — artifacts is undefined, not a fake default', () => {
    writeFileSync(path(), JSON.stringify(OLD_RECORD, null, 2), 'utf8');
    const info = readInstallInfo(path());
    expect(info).not.toBeNull();
    expect(info?.publicUrl).toBe('https://build.coresynth.io');
    expect(info?.artifacts).toBeUndefined();
  });

  it('keeps every existing connection field intact on a new record', () => {
    writeFileSync(path(), serializeInstallInfo(fresh()), 'utf8');
    const info = readInstallInfo(path());
    expect(info).toMatchObject(OLD_RECORD);
  });

  it('returns null for a missing file (a plain npm install) — unchanged behaviour', () => {
    expect(readInstallInfo(path())).toBeNull();
  });

  it('returns null (not throw) for a corrupt file — unchanged behaviour', () => {
    writeFileSync(path(), '{ not json', 'utf8');
    expect(readInstallInfo(path())).toBeNull();
  });
});

describe('cli/installInfo artifacts record', () => {
  it('round-trips a full record through serialize + read, units and enabled flags included', () => {
    const info = fresh();
    writeFileSync(path(), serializeInstallInfo(info), 'utf8');
    expect(readInstallInfo(path())).toEqual(info);
  });

  // The whole point of the record: an old file says "don't know what was created", a fresh file with
  // no agent CLIs says "none were installed" — the uninstall must be able to tell these apart.
  it('distinguishes "unknown" (no artifacts field) from "none installed" (empty agentClis)', () => {
    writeFileSync(path(), JSON.stringify(OLD_RECORD, null, 2), 'utf8');
    expect(readInstallInfo(path())?.artifacts?.agentClis).toBeUndefined();

    writeFileSync(path(), serializeInstallInfo(fresh({ agentClis: [] })), 'utf8');
    expect(readInstallInfo(path())?.artifacts?.agentClis).toEqual([]);
  });

  it('keeps the tri-state serviceUserCreated exactly (true/false/null) — no coercion, no default', () => {
    for (const created of [true, false, null]) {
      writeFileSync(path(), serializeInstallInfo(fresh({ serviceUserCreated: created })), 'utf8');
      expect(readInstallInfo(path())?.artifacts?.serviceUserCreated).toBe(created);
    }
  });

  it('a fresh record without a domain deployment has no proxy entry (undefined, not null/garbage)', () => {
    writeFileSync(path(), serializeInstallInfo(fresh({ proxy: undefined })), 'utf8');
    expect(readInstallInfo(path())?.artifacts?.proxy).toBeUndefined();
  });

  it('records sudoers=false and an empty unit list faithfully (not as absent fields)', () => {
    const bare = fresh({ sudoers: false, units: [] });
    writeFileSync(path(), serializeInstallInfo(bare), 'utf8');
    const info = readInstallInfo(path());
    expect(info?.artifacts?.sudoers).toBe(false);
    expect(info?.artifacts?.units).toEqual([]);
  });
});
