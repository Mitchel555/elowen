import type { WorkflowState } from './transcript';

/** Geometry and labels for the workflow DAG view — the browser counterpart of the CLI's
 *  `workflowCanvas.ts`. Everything here is pure: the modal supplies the live snapshot and gets back
 *  coordinates it only has to paint, so the layout can be verified without a DOM (jsdom lays out
 *  nothing, which makes this the only place the geometry can actually be tested). */

/** Node box in SVG user units. Wide enough for an id plus a short task line at the modal's font size. */
export const DAG_NODE_W = 184;
/** A node is drawn one of two ways, exactly as the CLI canvas does it (workflowCanvas.ts:99): the node
 *  that is RUNNING or SELECTED earns a full card carrying its live activity and vitals, everything else
 *  collapses to a single titled row. Uniform boxes are what made the web graph read as a flat grid — with
 *  24 nodes, 24 identical rectangles say nothing about where the work actually is. */
export const DAG_NODE_H = 66;
export const DAG_NODE_H_COMPACT = 28;
const COLUMN_GAP = 72;
const ROW_GAP = 14;
const PADDING = 16;
/** Edge routing inside the gutter between two columns: how far in the first vertical track sits, how far
 *  apart the tracks are, and how many exist before they repeat. Four tracks span 33px of the 72px gutter,
 *  which keeps every one of them clear of both the source's right edge and the target's arrowhead. */
const GUTTER_INSET = 20;
const GUTTER_LANE_GAP = 11;
const GUTTER_LANES = 4;
/** Corner rounding of an orthogonal edge — enough to read as a curve, small enough to keep the run straight. */
const CORNER_R = 9;

export interface DagNodeInput {
  id: string;
  deps: readonly string[];
  /** Draw this one as a full card rather than a compact row (running, or currently selected). */
  full?: boolean;
}

interface PlacedDagNode {
  id: string;
  /** Topological wave (0 = root) and the node's index within that wave — what the arrow keys walk. */
  column: number;
  row: number;
  /** Top-left corner of the node box. */
  x: number;
  y: number;
  /** Box height for this node — the caller paints it, so it never has to re-derive the card/row choice. */
  height: number;
  full: boolean;
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

  const heightOf = (node: DagNodeInput): number => (node.full === true ? DAG_NODE_H : DAG_NODE_H_COMPACT);
  const columnHeight = (column: readonly DagNodeInput[]): number =>
    column.reduce((sum, node) => sum + heightOf(node), 0) + Math.max(0, column.length - 1) * ROW_GAP;
  const tallest = Math.max(...columns.map(columnHeight));
  const placed: PlacedDagNode[] = [];
  columns.forEach((column, columnIndex) => {
    // Columns mix card and row heights, so each one is stacked with a running cursor and centred against
    // the tallest — a fixed per-row pitch would leave gaps wherever a column has no full card.
    let cursor = PADDING + Math.round((tallest - columnHeight(column)) / 2);
    column.forEach((node, row) => {
      const height = heightOf(node);
      placed.push({
        id: node.id,
        column: columnIndex,
        row,
        x: PADDING + columnIndex * (DAG_NODE_W + COLUMN_GAP),
        y: cursor,
        height,
        full: node.full === true,
      });
      cursor += height + ROW_GAP;
    });
  });

  const at = new Map(placed.map((p) => [p.id, p]));
  const edges: PlacedDagEdge[] = [];
  // Every edge entering a column gets its OWN vertical track in the gutter before it, the way the CLI
  // canvas assigns gutter lanes. Giving them all the same bend is what turns a busy graph into a tangle:
  // the vertical runs land on top of each other precisely where the edges are densest. Lanes are per
  // target column, so two columns can reuse the same offsets without ever sharing a line.
  const laneOf = new Map<number, number>();
  for (const node of nodes) {
    const target = at.get(node.id);
    if (!target) continue;
    for (const dep of node.deps) {
      const source = at.get(dep);
      // A backward edge means the data carries a cycle the engine would have rejected; drawing it would
      // only produce a curve looping back over the graph.
      if (!source || source.column >= target.column) continue;
      const sx = source.x + DAG_NODE_W;
      const sy = source.y + source.height / 2;
      const tx = target.x;
      const ty = target.y + target.height / 2;
      if (sy === ty) {
        // Same row: a straight shot needs no gutter track and no corners.
        edges.push({ from: dep, to: node.id, d: `M${sx} ${sy} L${tx} ${ty}` });
        continue;
      }
      const lane = laneOf.get(target.column) ?? 0;
      laneOf.set(target.column, lane + 1);
      const track = tx - COLUMN_GAP + GUTTER_INSET + (lane % GUTTER_LANES) * GUTTER_LANE_GAP;
      const down = ty > sy ? 1 : -1;
      // Corners stay circular by capping the radius at half of each leg they have to turn through.
      const radius = Math.min(CORNER_R, Math.abs(ty - sy) / 2, Math.abs(track - sx), Math.abs(tx - track));
      const d = radius > 0
        ? `M${sx} ${sy} L${track - radius} ${sy} Q${track} ${sy} ${track} ${sy + down * radius}`
          + ` L${track} ${ty - down * radius} Q${track} ${ty} ${track + radius} ${ty} L${tx} ${ty}`
        : `M${sx} ${sy} L${track} ${sy} L${track} ${ty} L${tx} ${ty}`;
      edges.push({ from: dep, to: node.id, d });
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
