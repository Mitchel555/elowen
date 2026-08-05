import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { elowenClient, BASE } from '../../lib/elowenClient';

// Reports sent as the page goes away must use sendBeacon: the browser takes ownership of the request and
// still delivers it once the document is frozen, whereas WebKit drops a keepalive fetch issued while
// backgrounding. That dropped report is what made the daemon think the phone was still reading the answer,
// so the "turn finished" push never fired.

const fetchMock = vi.fn();
const beaconMock = vi.fn((_url: string, _body?: BodyInit | null) => true);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { sendBeacon: beaconMock });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  beaconMock.mockReset();
  beaconMock.mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('page-departure reports', () => {
  it('sends the visibility report by beacon, not fetch', () => {
    elowenClient.brainVisibility({ client: 'c1', hidden: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0][0]).toBe(`${BASE}/brain/visibility`);
  });

  it('sends the detach report by beacon too', () => {
    elowenClient.brainSessionStop({ client: 'c1', detachOnly: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(beaconMock.mock.calls[0][0]).toBe(`${BASE}/brain/session/stop`);
  });

  it('carries the payload so the daemon learns which client went off screen', async () => {
    elowenClient.brainVisibility({ client: 'phone-1', hidden: true });
    const blob = beaconMock.mock.calls[0][1] as Blob;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual({ client: 'phone-1', hidden: true });
  });

  it('falls back to fetch when the engine has no sendBeacon', () => {
    vi.stubGlobal('navigator', {});
    elowenClient.brainVisibility({ client: 'c1', hidden: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/brain/visibility`);
  });

  it('falls back to fetch when sendBeacon refuses the request', () => {
    beaconMock.mockReturnValue(false);
    elowenClient.brainVisibility({ client: 'c1', hidden: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
