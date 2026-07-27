import { describe, it, expect } from 'vitest';
import { arcPlacements, ringPlacements, type Placement } from '../../../modules/advisor/CommandOrbit';

/** The rendered pod boxes, rounded UP from components.css (6rem / 11.5rem wide, icon + label tall).
 *  The layout is pure math — jsdom lays nothing out — so the arrangement is verified here directly:
 *  what the phone must never do is put two pods on top of each other or push one off the screen. */
const ARC_POD = { w: 96, h: 78 };
const ORBIT_POD = { w: 184, h: 56 };

function makePods(kinds: string[]): HTMLElement[] {
  return kinds.map((kind, index) => {
    const pod = document.createElement('div');
    pod.dataset.kind = kind;
    pod.dataset.pod = `pod-${index}`;
    return pod;
  });
}

function overlaps(a: Placement, b: Placement, box: { w: number; h: number }): boolean {
  return Math.abs(a.x - b.x) < box.w && Math.abs(a.y - b.y) < box.h;
}

function collisions(placements: Placement[], box: { w: number; h: number }): string[] {
  const hits: string[] = [];
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!;
      const b = placements[j]!;
      if (overlaps(a, b, box)) hits.push(`${a.pod.dataset['pod']}×${b.pod.dataset['pod']}`);
    }
  }
  return hits;
}

/** The phone field: three mode pods on the inner sweep, three action pods on the outer one. */
const PHONE_PODS = ['mode', 'mode', 'mode', 'action', 'picker', 'action'];

describe('command field geometry', () => {
  // Every phone width we care about, from an SE up to a Pro Max.
  for (const width of [320, 360, 390, 414, 430]) {
    it(`keeps the thumb arc collision-free and on screen at ${width}px`, () => {
      const placements = arcPlacements(makePods(PHONE_PODS), width, 720);
      expect(collisions(placements, ARC_POD)).toEqual([]);
      for (const { x } of placements) {
        expect(x - ARC_POD.w / 2).toBeGreaterThanOrEqual(0);
        expect(x + ARC_POD.w / 2).toBeLessThanOrEqual(width);
      }
    });
  }

  it('keeps every arc pod above the anchor and within the reserved band', () => {
    const placements = arcPlacements(makePods(PHONE_PODS), 390, 720);
    for (const { y } of placements) {
      expect(y).toBeLessThan(720); // above the bottom edge it is anchored to
      expect(y).toBeGreaterThan(720 - 400); // inside the band the core layout reserves for it
    }
  });

  it('puts the mode pods closer to the thumb than the actions', () => {
    const placements = arcPlacements(makePods(PHONE_PODS), 390, 720);
    const modes = placements.filter((p) => p.pod.dataset['kind'] === 'mode');
    const actions = placements.filter((p) => p.pod.dataset['kind'] !== 'mode');
    const mean = (group: Placement[]): number => group.reduce((sum, p) => sum + p.y, 0) / group.length;
    // Nearest-to-the-thumb pod, and the sweep as a whole: both are the modes'.
    expect(Math.max(...modes.map((p) => p.y))).toBeGreaterThan(Math.max(...actions.map((p) => p.y)));
    expect(mean(modes)).toBeGreaterThan(mean(actions));
  });

  it('keeps a partial catalog on the arc — a single mode pod sits on the sweep top', () => {
    const placements = arcPlacements(makePods(['mode']), 390, 720);
    expect(placements).toHaveLength(1);
    expect(placements[0]!.x).toBeCloseTo(195, 5);
  });

  it('keeps the desktop ring collision-free around the core', () => {
    const pods = makePods(['mode', 'mode', 'mode', 'action', 'picker', 'action', 'picker']);
    const placements = ringPlacements(pods, 640, 400, 1280, 800);
    expect(collisions(placements, ORBIT_POD)).toEqual([]);
    // …and clear of the owl itself (a 15rem core: 120px from its centre).
    for (const { x, y } of placements) {
      expect(Math.hypot(x - 640, y - 400)).toBeGreaterThan(120 + ORBIT_POD.h / 2);
    }
  });
});
