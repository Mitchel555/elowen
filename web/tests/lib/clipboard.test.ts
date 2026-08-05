import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyText } from '../../lib/clipboard';

// jsdom has no Clipboard API; each test installs the exact write behavior it needs.
const mockWriteText = (writeText: () => Promise<unknown>) => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
};

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('resolves true and writes the text when the browser allows it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockWriteText(writeText);
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('resolves false when the browser refuses the write', async () => {
    mockWriteText(vi.fn().mockRejectedValue(new Error('permission denied')));
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('resolves false when the clipboard API is unavailable', async () => {
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('does not leak an unhandled rejection when the write is refused', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    mockWriteText(vi.fn().mockRejectedValue(new Error('permission denied')));
    await expect(copyText('hello')).resolves.toBe(false);
    // Give a stray rejection a chance to surface before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', onUnhandled);
  });
});
