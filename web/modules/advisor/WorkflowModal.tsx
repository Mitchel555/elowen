'use client';
import { useMemo, useRef, useState } from 'react';
import { Workflow } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { useTranslation } from '../../lib/i18n';
import { useMobileViewport } from '../../lib/useMobile';
import { formatTokens } from '../../lib/format';
import { DAG_NODE_H, DAG_NODE_W, layoutDag, stepDagSelection, workflowLabel, workflowProgress } from '../../lib/workflowDag';
import type { DagDirection } from '../../lib/workflowDag';
import { useBrainChat } from './BrainChatProvider';
import type { WorkflowState } from '../../lib/transcript';

/** The navigable DAG view of a running workflow — the web counterpart of the CLI's workflow modal
 *  (src/cli/chat/workflowModal.ts). Waves become columns, dependencies become curves, and the selected
 *  node's vitals sit in a dock under the graph. It reads the LIVE snapshot out of the chat controller, so
 *  an open modal tracks the workflow as its nodes run; a phone gets the same DAG as a wave-grouped list,
 *  because a hand-sized web of boxes is unreadable (the CLI falls back the same way on a narrow terminal). */

type WorkflowNode = WorkflowState['nodes'][number];

/** Status is carried by GLYPH AND BORDER, never by colour alone. */
const NODE_GLYPH: Record<WorkflowNode['status'], string> = { pending: '○', running: '●', done: '✓', error: '✗' };
const NODE_TONE: Record<WorkflowNode['status'], string> = {
  pending: 'border-dashed border-border text-text-muted',
  running: 'border-accent text-text wf-dag__node--running',
  done: 'border-success/60 text-text',
  error: 'border-danger/70 text-text',
};
const GLYPH_TONE: Record<WorkflowNode['status'], string> = {
  pending: 'text-text-muted',
  running: 'text-accent',
  done: 'text-success',
  error: 'text-danger',
};

const ARROW_KEYS: Record<string, DagDirection> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

export function WorkflowModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { workflows } = useBrainChat();
  const mobile = useMobileViewport();
  // Pin the selection by node id, not by index: nodes get appended mid-run (WorkflowAddNodes) and the
  // wave layout reorders as statuses change, so an index would drift onto a different node.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const wf = workflows.find((w) => w.id === workflowId) ?? null;
  const nodes = useMemo(() => wf?.nodes ?? [], [wf]);
  const layout = useMemo(() => layoutDag(nodes.map((n) => ({ id: n.id, deps: n.deps }))), [nodes]);

  const statusLabel: Record<WorkflowNode['status'], string> = {
    pending: t.workflowModal.statusPending,
    running: t.workflowModal.statusRunning,
    done: t.workflowModal.statusDone,
    error: t.workflowModal.statusError,
  };

  // Nothing picked yet → open on the live work, which is what the user came to watch.
  const selected = nodes.find((n) => n.id === pickedId)
    ?? nodes.find((n) => n.status === 'running')
    ?? nodes[0]
    ?? null;

  const move = (direction: DagDirection): void => {
    const next = stepDagSelection(layout, selected?.id ?? null, direction);
    if (!next) return;
    setPickedId(next);
    nodeRefs.current.get(next)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const direction = ARROW_KEYS[event.key];
    if (!direction) return;
    event.preventDefault();
    move(direction);
  };

  const nodeButton = (node: WorkflowNode, className: string, style?: React.CSSProperties) => (
    <button
      key={node.id}
      ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }}
      type="button"
      data-testid={`workflow-node-${node.id}`}
      data-status={node.status}
      aria-pressed={node.id === selected?.id}
      aria-label={`${node.id} — ${statusLabel[node.status]}`}
      onClick={() => setPickedId(node.id)}
      style={style}
      className={`${className} flex flex-col justify-center gap-0.5 rounded-lg border bg-elevated px-2.5 text-left transition-colors ${NODE_TONE[node.status]} ${node.id === selected?.id ? 'ring-1 ring-accent' : ''}`}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={`wf-dag__pulse shrink-0 text-tiny ${GLYPH_TONE[node.status]}`}>{NODE_GLYPH[node.status]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-tiny">{node.id}</span>
      </span>
      <span className="truncate text-tiny text-text-muted">{node.detail || node.task}</span>
    </button>
  );

  const body = () => {
    if (!wf) return <p className="p-5 text-xs text-text-muted">{t.workflowModal.gone}</p>;
    if (nodes.length === 0) return <p className="p-5 text-xs text-text-muted">{t.workflowModal.empty}</p>;
    if (mobile) {
      let wave = -1;
      return (
        <div data-testid="workflow-dag-list" className="min-h-0 flex-1 overflow-auto p-3" onKeyDown={onKeyDown}>
          <ul className="flex flex-col gap-1.5">
            {layout.nodes.map((placed) => {
              const node = nodes.find((n) => n.id === placed.id);
              if (!node) return null;
              const head = placed.column !== wave ? (wave = placed.column) : null;
              return (
                <li key={placed.id} className="flex flex-col gap-1.5">
                  {head !== null ? (
                    <span className="mt-1 text-tiny uppercase tracking-wide text-text-muted">
                      {t.workflowModal.wave.replace('{n}', String(placed.column + 1))}
                    </span>
                  ) : null}
                  {nodeButton(node, 'min-h-[3rem] w-full py-1.5')}
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    return (
      <div
        data-testid="workflow-dag-graph"
        role="group"
        aria-label={t.workflowModal.graph}
        className="min-h-0 flex-1 overflow-auto p-4"
        onKeyDown={onKeyDown}
      >
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg
            aria-hidden
            className="wf-dag__edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.d}
                className={`wf-dag__edge${nodes.find((n) => n.id === edge.to)?.status === 'running' ? ' wf-dag__edge--live' : ''}`}
              />
            ))}
          </svg>
          {layout.nodes.map((placed) => {
            const node = nodes.find((n) => n.id === placed.id);
            return node
              ? nodeButton(node, 'absolute py-1.5', { left: placed.x, top: placed.y, width: DAG_NODE_W, height: DAG_NODE_H })
              : null;
          })}
        </div>
      </div>
    );
  };

  const outcome = (node: WorkflowNode): { label: string; text: string } => {
    if (node.status === 'error') return { label: t.workflowModal.error, text: node.error || t.workflowModal.failed };
    if (node.status === 'done') return { label: t.workflowModal.result, text: node.result || t.workflowModal.noOutput };
    if (node.status === 'running') return { label: t.workflowModal.activity, text: node.detail || t.workflowModal.working };
    return { label: t.workflowModal.activity, text: t.workflowModal.notStarted };
  };

  const selectedOutcome = selected ? outcome(selected) : null;
  const meta = selected ? [
    statusLabel[selected.status],
    selected.model ? `${t.agents.model}: ${selected.model}` : '',
    selected.tokens !== undefined ? `${formatTokens(selected.tokens)} ${t.agents.tokens.toLowerCase()}` : '',
    selected.seconds !== undefined ? `${selected.seconds}s` : '',
    `${t.workflowModal.deps}: ${selected.deps.join(', ') || t.workflowModal.depsNone}`,
  ].filter(Boolean) : [];

  return (
    <Modal
      title={wf ? workflowLabel(wf) : t.telemetry.workflow}
      description={wf ? `${workflowProgress(wf)} ${t.telemetry.workflowNodes}` : undefined}
      onClose={onClose}
      size="lg"
      icon={Workflow}
    >
      <div data-testid="workflow-modal" className="flex min-h-0 flex-1 flex-col">
        {body()}
        {selected && selectedOutcome ? (
          <div data-testid="workflow-node-detail" className="shrink-0 border-t border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tiny text-text-muted">
              <span aria-hidden className={GLYPH_TONE[selected.status]}>{NODE_GLYPH[selected.status]}</span>
              <span className="font-mono text-text">{selected.id}</span>
              {meta.map((entry) => <span key={entry}>· {entry}</span>)}
            </div>
            <p className="mt-1.5 text-tiny text-text">{selected.task}</p>
            <p className="mt-2 text-tiny uppercase tracking-wide text-text-muted">{selectedOutcome.label}</p>
            {/* A node's result or stack trace can be long: it scrolls in place instead of stretching the
                modal until the graph is pushed off the screen. */}
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-tiny text-text-muted">
              {selectedOutcome.text}
            </pre>
            {mobile ? null : <p className="mt-2 text-tiny text-text-muted">{t.workflowModal.hint}</p>}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
