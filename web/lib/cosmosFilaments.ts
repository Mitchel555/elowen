/** The curved filament that ties an orbital field's core to one of its pods — the shared drawing step
 *  behind every cosmos surface (the dashboard hero, the chat command field). The stroke vocabulary lives
 *  in `cosmos-fil--base` / `cosmos-fil--flow` (app/styles/components.css); this only builds the geometry,
 *  so the two fields cannot drift into different curves or animation wiring. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface FilamentPoint { x: number; y: number }

/** Append the base + flow pair for one core→pod filament. `pod` tags both paths for hover lighting,
 *  `index` feeds the staggered entrance delay, `extraClass` re-tones them (e.g. an alert filament). */
export function appendFilament(
  svg: SVGSVGElement,
  core: FilamentPoint,
  pod: FilamentPoint,
  meta: { pod: string; index: string; extraClass?: string },
): void {
  // A gentle perpendicular bow so the filament reads as drawn rather than ruled.
  const mx = (core.x + pod.x) / 2 + (pod.y - core.y) * 0.12;
  const my = (core.y + pod.y) / 2 - (pod.x - core.x) * 0.12;
  const d = `M${core.x} ${core.y} Q${mx} ${my} ${pod.x} ${pod.y}`;
  for (const kind of ['base', 'flow'] as const) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '1');
    path.classList.add(`cosmos-fil--${kind}`);
    path.dataset.pod = meta.pod;
    path.style.setProperty('--i', meta.index);
    // The dash-based draw-in needs the path's own length; jsdom has no geometry API, hence the guard.
    if (kind === 'base' && typeof path.getTotalLength === 'function') {
      const len = path.getTotalLength();
      path.style.setProperty('--len', String(len));
      path.setAttribute('stroke-dasharray', String(len));
    }
    if (meta.extraClass) path.classList.add(meta.extraClass);
    svg.appendChild(path);
  }
}

/** Light one pod's filaments and dim the rest (`null` clears). Shared so hover reads identically. */
export function lightFilament(svg: SVGSVGElement, pod: string | null): void {
  for (const path of svg.querySelectorAll('path')) {
    path.classList.remove('is-lit', 'is-dim');
    if (pod != null) path.classList.add(path.dataset.pod === pod ? 'is-lit' : 'is-dim');
  }
}
