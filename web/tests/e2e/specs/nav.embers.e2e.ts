// The navigation rail's ambient ember canvas must stay the size of the rail. It once did not: the canvas
// measured ITSELF and then wrote that measurement back into `canvas.width`. A canvas is a replaced
// element, so its layout size follows its bitmap attributes — every ResizeObserver pass multiplied the
// element by `devicePixelRatio` and it ran away exponentially (past 30M px within a second), painting one
// enormous blurred ember over the whole rail. Nobody saw it at dpr 1, where the multiplier is 1 and the
// loop is a fixed point, which is exactly why jsdom tests and a casual look could not catch it. This runs
// at dpr 2 in a real browser with real layout, the only place the defect exists.
import { test, expect } from '@playwright/test';

test.use({ deviceScaleFactor: 2 });

test('the nav ember canvas stays sized to the rail instead of running away', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that owns the nav rail');

  await page.goto('/dash');
  const canvas = page.locator('nav canvas.ember-fall');
  await expect(canvas).toBeAttached();

  const measure = () => page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('nav canvas.ember-fall');
    if (!element) throw new Error('ember canvas is gone');
    const host = element.parentElement!;
    return {
      bitmap: { width: element.width, height: element.height },
      box: { width: element.clientWidth, height: element.clientHeight },
      host: { width: host.clientWidth, height: host.clientHeight },
      dpr: window.devicePixelRatio,
    };
  });

  // Long enough for many observer passes: the runaway needed well under a second to blow past 30M px.
  await page.waitForTimeout(1500);
  const settled = await measure();

  expect(settled.dpr).toBe(2); // the multiplier has to be > 1 or this test proves nothing
  // The canvas fills its host exactly — `inset: 0` alone would leave a replaced element at 300×150.
  expect(settled.box).toEqual(settled.host);
  // And its bitmap is the host scaled by dpr, not by dpr to the power of however many passes have run.
  expect(settled.bitmap.width).toBe(Math.round(settled.host.width * settled.dpr));
  expect(settled.bitmap.height).toBe(Math.round(settled.host.height * settled.dpr));

  // Stable over time, not merely small once: a slower runaway would still be growing on the second look.
  await page.waitForTimeout(1000);
  expect(await measure()).toEqual(settled);
});
