import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider } from '../lib/i18n';
import { ThemeProvider } from '../lib/useTheme';
import { EffectsProvider } from '../lib/useEffects';
import { domMax } from 'motion/react';

/** Drive the `(max-width: 767px)` media query behind useMobile / useMobileViewport. */
export function setViewport(mobile: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: mobile, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  } as MediaQueryList));
}

/** Watch whether a node matching `selector` was EVER in the document — a query run after render cannot
 *  see a variant that the first commit mounted and the next one dropped. Both sides of every mutation are
 *  inspected: a node mounted inside a bigger inserted subtree has no record of its own, but its later
 *  removal does name it (and a detached node keeps its own subtree, so the match still holds). */
export function watchMounts(selector: string): () => boolean {
  let mounted = false;
  const hit = (nodes: NodeList): boolean => {
    for (const node of nodes) {
      if (node instanceof HTMLElement && (node.matches(selector) || node.querySelector(selector))) return true;
    }
    return false;
  };
  // Accumulate in the callback: the observer DRAINS its queue when it delivers, so a later takeRecords()
  // would come back empty for everything that already fired.
  const scan = (records: MutationRecord[]): void => {
    for (const r of records) if (hit(r.addedNodes) || hit(r.removedNodes)) mounted = true;
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    scan(observer.takeRecords());
    observer.disconnect();
    return mounted;
  };
}

export function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <EffectsProvider features={domMax}>
          <ThemeProvider>
            <LanguageProvider>{children}</LanguageProvider>
          </ThemeProvider>
        </EffectsProvider>
      </QueryClientProvider>
    ),
  };
}
