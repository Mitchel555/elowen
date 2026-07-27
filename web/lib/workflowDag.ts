import type { WorkflowState } from './transcript';

/** Geometry and labels for the workflow DAG view — the browser counterpart of the CLI's
 *  `workflowCanvas.ts`. Everything here is pure: the modal supplies the live snapshot and gets back
 *  coordinates it only has to paint, so the layout can be verified without a DOM (jsdom lays out
 *  nothing, which makes this the only place the geometry can actually be tested). */

/** Node box in SVG user units. Wide enough for an id plus a short task line at the modal's font size. */
export const DAG_NODE_W = 184;
export const DAG_NODE_H = 62;
const COLUMN_GAP = 72;
const ROW_GAP = 20;
const PADDING = 16;

export interface DagNodeInput { id: string; deps: readonly string[] }

interface PlacedDagNode {
  id: string;
  /** Topological wave (0 = root) and the node's index within that wave — what the arrow keys walk. */
  column: number;
  row: number;
  /** Top-left corner of the node box. */
  x: number;
  y: number;
}

/** One dependency drawn as a cubic curve from the source's right edge into the target's left edge. */
interface PlacedDagEdge { from: string; to: string; d: string }

export interface DagLayout { nodes: PlacedDagNode[]; edges: PlacedDagEdge[]; width: number; height: number }

/** Longest-path layering: a node's wave is one past its deepest dependency, so a column holds exactly
 *  the nodes that may run concurrently. Total by construction — a dangling dep contributes nothing (its
 *  dependent becomes a root) and a cycle breaks at re-entry, so malformed data still lays out every node
 *  instead of hanging the tab or dropping the unreachable ones. */
function waves(nodes: readonly DagNodeInput[]): DagNodeInput[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const known = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (id: string): number => {
    const cached = known.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node || visiting.has(id)) return -1;
    visiting.add(id);
    const wave = node.deps.reduce((deepest, dep) => (dep === id ? deepest : Math.max(deepest, waveOf(dep) + 1)), 0);
    visiting.delete(id);
    known.set(id, wave);
    return wave;
  };
  for (const node of nodes) waveOf(node.id);

  const columns: DagNodeInput[][] = [];
  for (const node of nodes) (columns[known.get(node.id) ?? 0] ??= []).push(node);
  const dense = columns.filter((column) => column.length > 0);

  // Within a column, order by the average row of the node's dependencies (barycentre) so edges tend to
  // run straight instead of crossing; ties keep declaration order, since the sort is stable.
  const rank = new Map<string, number>();
  dense[0]?.forEach((n, i) => rank.set(n.id, i));
  for (let c = 1; c < dense.length; c += 1) {
    const key = (n: DagNodeInput): number => {
      const ranks = n.deps.map((d) => rank.get(d)).filter((r): r is number => r !== undefined);
      return ranks.length ? ranks.reduce((sum, r) => sum + r, 0) / ranks.length : Number.MAX_SAFE_INTEGER;
    };
    const ordered = [...(dense[c] ?? [])].sort((a, b) => key(a) - key(b));
    dense[c] = ordered;
    ordered.forEach((n, i) => rank.set(n.id, i));
  }
  return dense;
}

/** Place every node and dependency of a DAG on a canvas: waves become columns left to right, each column
 *  centred against the tallest one so the graph reads as a flow rather than as a ragged top edge. */
export function layoutDag(nodes: readonly DagNodeInput[]): DagLayout {
  const columns = waves(nodes);
  if (columns.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const columnHeight = (count: number): number => count * DAG_NODE_H + Math.max(0, count - 1) * ROW_GAP;
  const tallest = Math.max(...columns.map((column) => columnHeight(column.length)));
  const placed: PlacedDagNode[] = [];
  columns.forEach((column, columnIndex) => {
    const top = PADDING + Math.round((tallest - columnHeight(column.length)) / 2);
    column.forEach((node, row) => {
      placed.push({
        id: node.id,
        column: columnIndex,
        row,
        x: PADDING + columnIndex * (DAG_NODE_W + COLUMN_GAP),
        y: top + row * (DAG_NODE_H + ROW_GAP),
      });
    });
  });

  const at = new Map(placed.map((p) => [p.id, p]));
  const edges: PlacedDagEdge[] = [];
  for (const node of nodes) {
    const target = at.get(node.id);
    if (!target) continue;
    for (const dep of node.deps) {
      const source = at.get(dep);
      // A backward edge means the data carries a cycle the engine would have rejected; drawing it would
      // only produce a curve looping back over the graph.
      if (!source || source.column >= target.column) continue;
      const sx = source.x + DAG_NODE_W;
      const sy = source.y + DAG_NODE_H / 2;
      const tx = target.x;
      const ty = target.y + DAG_NODE_H / 2;
      const bend = Math.round((tx - sx) / 2);
      edges.push({ from: dep, to: node.id, d: `M${sx} ${sy} C${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}` });
    }
  }

  return {
    nodes: placed,
    edges,
    width: PADDING * 2 + columns.length * DAG_NODE_W + (columns.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + tallest,
  };
}

export type DagDirection = 'up' | 'down' | 'left' | 'right';

/** Move the selection one step across the laid-out graph: up/down walk the current column, left/right
 *  cross to the neighbouring wave landing on the vertically nearest node — the selection moves the way
 *  the eye does. Clamped, never wrapped: falling off the top onto the bottom reads as teleporting. */
export function stepDagSelection(layout: DagLayout, currentId: string | null, direction: DagDirection): string | null {
  const current = layout.nodes.find((n) => n.id === currentId);
  if (!current) return layout.nodes[0]?.id ?? null;

  if (direction === 'up' || direction === 'down') {
    const lane = layout.nodes.filter((n) => n.column === current.column);
    const index = lane.findIndex((n) => n.id === current.id) + (direction === 'down' ? 1 : -1);
    return lane[Math.max(0, Math.min(lane.length - 1, index))]?.id ?? current.id;
  }

  const columns = [...new Set(layout.nodes.map((n) => n.column))].sort((a, b) => a - b);
  const at = columns.indexOf(current.column) + (direction === 'right' ? 1 : -1);
  const target = columns[Math.max(0, Math.min(columns.length - 1, at))];
  if (target === undefined || target === current.column) return current.id;
  return layout.nodes
    .filter((n) => n.column === target)
    .reduce((best, n) => (Math.abs(n.y - current.y) < Math.abs(best.y - current.y) ? n : best)).id;
}

/** Completed / total nodes of a DAG — the tally that tells a running workflow's progress at a glance. */
export function workflowProgress(wf: WorkflowState): string {
  return `${wf.nodes.filter((node) => node.status === 'done').length}/${wf.nodes.length}`;
}

/** The workflow's own title, falling back to its first node's task — an untitled DAG is still a thing the
 *  user recognizes by what it started with, never by its opaque id. */
export function workflowLabel(wf: WorkflowState): string {
  return wf.title?.trim() || wf.nodes[0]?.task || wf.id;
}
