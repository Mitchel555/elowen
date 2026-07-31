import { describe, it, expect } from 'vitest';
import { DAG_NODE_W, layoutDag, stepDagSelection, workflowLabel, workflowProgress } from '../../lib/workflowDag';
import type { DagNodeInput } from '../../lib/workflowDag';
import type { WorkflowState } from '../../lib/transcript';

// The DAG layout is the one piece of the workflow modal worth testing hard: jsdom lays nothing out, so
// the geometry can only be trusted if it is pure maths verified on its own.

const node = (id: string, deps: string[] = []): DagNodeInput => ({ id, deps });

/** Do two node boxes share any area? The layout's core promise is that they never do. Heights vary per
 *  node (a full card is taller than a compact row), so the check uses each box's own height. */
function overlaps(a: { x: number; y: number; height: number }, b: { x: number; y: number; height: number }): boolean {
  return a.x < b.x + DAG_NODE_W && b.x < a.x + DAG_NODE_W && a.y < b.y + b.height && b.y < a.y + a.height;
}

const columnOf = (layout: ReturnType<typeof layoutDag>, id: string): number =>
  layout.nodes.find((n) => n.id === id)?.column ?? -1;

describe('layoutDag', () => {
  it('puts a chain into one column per dependency depth', () => {
    const layout = layoutDag([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(columnOf(layout, 'a')).toBe(0);
    expect(columnOf(layout, 'b')).toBe(1);
    expect(columnOf(layout, 'c')).toBe(2);
  });

  it('layers a diamond by its DEEPEST dependency, not its first', () => {
    // `d` depends on a root as well as on a second-level node: longest-path layering must push it past
    // `c`, otherwise the edge c→d would run backwards through the graph.
    // Both dependency orders matter: whichever of the two is listed first, the DEEPER one decides.
    const layout = layoutDag([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['a', 'c']), node('e', ['c', 'a'])]);
    expect(columnOf(layout, 'b')).toBe(1);
    expect(columnOf(layout, 'c')).toBe(1);
    expect(columnOf(layout, 'd')).toBe(2);
    expect(columnOf(layout, 'e')).toBe(2);
  });

  it('never overlaps two node boxes', () => {
    const layout = layoutDag([
      node('a'), node('b'), node('c', ['a']), node('d', ['a', 'b']), node('e', ['b']), node('f', ['c', 'd', 'e']),
    ]);
    for (const [i, first] of layout.nodes.entries()) {
      for (const second of layout.nodes.slice(i + 1)) expect(overlaps(first, second)).toBe(false);
    }
  });

  it('keeps declaration order for nodes the barycentre cannot separate', () => {
    // Siblings of one root share a barycentre, so only a stable ordering keeps them in the order the
    // workflow declared them — the order the user reads in the task list.
    const layout = layoutDag([node('root'), node('first', ['root']), node('second', ['root']), node('third', ['root'])]);
    const column = layout.nodes.filter((n) => n.column === 1);
    expect(column.map((n) => n.id)).toEqual(['first', 'second', 'third']);
    expect(column.map((n) => n.row)).toEqual([0, 1, 2]);
  });

  it('is deterministic — the same DAG lays out identically every time', () => {
    const input = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])];
    expect(layoutDag(input)).toEqual(layoutDag(input));
  });

  it('places every node of a cyclic graph instead of hanging on it', () => {
    // The engine rejects cycles, but a malformed snapshot must not freeze the browser tab.
    const layout = layoutDag([node('a', ['b']), node('b', ['a']), node('c', ['a'])]);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('drops an edge that would run backwards through a cycle', () => {
    const layout = layoutDag([node('a', ['b']), node('b', ['a'])]);
    for (const edge of layout.edges) {
      expect(columnOf(layout, edge.from)).toBeLessThan(columnOf(layout, edge.to));
    }
  });

  it('treats a node whose dependency is unknown as a root and draws no edge for it', () => {
    const layout = layoutDag([node('a'), node('lonely', ['ghost'])]);
    expect(columnOf(layout, 'lonely')).toBe(0);
    expect(layout.edges).toHaveLength(0);
  });

  it('draws one curve per real dependency, ending at the dependent node', () => {
    const layout = layoutDag([node('a'), node('b', ['a'])]);
    expect(layout.edges).toHaveLength(1);
    const [edge] = layout.edges;
    expect(edge).toMatchObject({ from: 'a', to: 'b' });
    const target = layout.nodes.find((n) => n.id === 'b');
    expect(edge?.d.startsWith('M')).toBe(true);
    expect(edge?.d.endsWith(`${target?.x} ${(target?.y ?? 0) + (target?.height ?? 0) / 2}`)).toBe(true);
  });

  it('gives a full node a taller box than a compact one and stacks the column around it', () => {
    // The graph's foreground: the live/selected node is a card, everything else a row. Uniform boxes are
    // what made 24 nodes read as a flat grid, so the two heights have to stay genuinely different.
    const layout = layoutDag([
      { id: 'a', deps: [], full: false }, { id: 'b', deps: [], full: true }, { id: 'c', deps: [], full: false },
    ]);
    const box = (id: string) => layout.nodes.find((n) => n.id === id);
    expect(box('b')?.height).toBeGreaterThan(box('a')?.height ?? 0);
    expect(box('b')?.full).toBe(true);
    expect(box('a')?.full).toBe(false);
    // Stacked with a running cursor: each node starts below the previous one's own height, never a fixed pitch.
    expect(box('b')?.y).toBe((box('a')?.y ?? 0) + (box('a')?.height ?? 0) + 14);
    expect(box('c')?.y).toBe((box('b')?.y ?? 0) + (box('b')?.height ?? 0) + 14);
  });

  it('routes edges entering one column on separate vertical tracks', () => {
    // Three deps converging on one node: the crossings only read as a flow if each vertical run has its
    // own track. Sharing one x is what made the web graph a tangle where the CLI's canvas stayed legible.
    const layout = layoutDag([node('a'), node('b'), node('c'), node('x', ['a', 'b', 'c'])]);
    const verticalTrack = (d: string): number | null => {
      // In an orthogonal run the horizontal leg ends at the track, so the first L's x IS the track.
      const first = /L(-?\d+(?:\.\d+)?) /.exec(d);
      return first?.[1] !== undefined ? Number(first[1]) : null;
    };
    const bent = layout.edges.map((e) => e.d).filter((d) => d.includes('Q'));
    expect(bent.length).toBeGreaterThanOrEqual(2);
    const tracks = bent.map(verticalTrack);
    expect(new Set(tracks).size).toBe(tracks.length);
  });

  it('sizes the canvas around every node it placed', () => {
    const layout = layoutDag([node('a'), node('b', ['a']), node('c', ['a'])]);
    for (const placed of layout.nodes) {
      expect(placed.x + DAG_NODE_W).toBeLessThanOrEqual(layout.width);
      expect(placed.y + placed.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('lays out an empty DAG without producing a canvas', () => {
    expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe('stepDagSelection', () => {
  const layout = layoutDag([node('a'), node('b'), node('c', ['a']), node('d', ['b'])]);

  it('walks the column with up/down and clamps at its ends', () => {
    expect(stepDagSelection(layout, 'a', 'down')).toBe('b');
    expect(stepDagSelection(layout, 'b', 'down')).toBe('b');
    expect(stepDagSelection(layout, 'b', 'up')).toBe('a');
    expect(stepDagSelection(layout, 'a', 'up')).toBe('a');
  });

  it('crosses to the neighbouring column landing on the vertically nearest node', () => {
    expect(stepDagSelection(layout, 'b', 'right')).toBe('d');
    expect(stepDagSelection(layout, 'd', 'left')).toBe('b');
    expect(stepDagSelection(layout, 'd', 'right')).toBe('d');
  });

  it('falls back to the first node when nothing is selected yet', () => {
    expect(stepDagSelection(layout, null, 'down')).toBe('a');
    expect(stepDagSelection(layout, 'gone', 'left')).toBe('a');
    expect(stepDagSelection(layoutDag([]), null, 'down')).toBeNull();
  });
});

describe('workflow labels', () => {
  const wf = (over: Partial<WorkflowState> = {}): WorkflowState => ({
    id: 'wf-1', toolCallId: 'call-1', status: 'running',
    nodes: [{ id: 'a', task: 'prozkoumat', status: 'done', deps: [] }],
    ...over,
  });

  it('prefers the workflow title, then its first task, then the raw id', () => {
    expect(workflowLabel(wf({ title: 'Rail parity' }))).toBe('Rail parity');
    expect(workflowLabel(wf({ title: '   ' }))).toBe('prozkoumat');
    expect(workflowLabel(wf({ nodes: [] }))).toBe('wf-1');
  });

  it('counts the finished nodes against the total', () => {
    expect(workflowProgress(wf({
      nodes: [
        { id: 'a', task: 'x', status: 'done', deps: [] },
        { id: 'b', task: 'y', status: 'running', deps: ['a'] },
        { id: 'c', task: 'z', status: 'pending', deps: ['b'] },
      ],
    }))).toBe('1/3');
  });
});
