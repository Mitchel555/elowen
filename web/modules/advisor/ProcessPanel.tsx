'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, TerminalSquare } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useBrainProcesses } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import { Modal } from '../../components/ui/Modal';
import type { ProcessInfo } from '../../lib/types';
import { isOwnProcess } from '../../lib/processScope';

/** Live output of one background process, polled while it runs. Mirrors the terminal plugin's rolling
 *  buffer (read via GET /brain/processes/:id/output). Exported so the telemetry rail opens THIS detail
 *  instead of growing a second output view of its own. */
export function ProcessOutputModal({ proc, onClose }: { proc: ProcessInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [output, setOutput] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stale = false;
    const pull = async () => {
      const r = await elowenClient.brainProcessOutput(proc.id).catch(() => null);
      if (!stale && r) setOutput(r.output);
    };
    void pull();
    const timer = proc.running ? setInterval(() => void pull(), 1500) : null;
    return () => { stale = true; if (timer) clearInterval(timer); };
  }, [proc.id, proc.running]);
  useEffect(() => { preRef.current?.scrollTo({ top: preRef.current.scrollHeight }); }, [output]);
  return (
    <Modal title={proc.command} description={proc.running ? t.processes.running : t.processes.exited} onClose={onClose} size="xl" icon={TerminalSquare}>
      <pre ref={preRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-bg p-4 font-mono text-tiny leading-relaxed text-text-muted">
        {output || t.processes.noOutput}
      </pre>
    </Modal>
  );
}

/** A panel next to the todos listing the background shell processes THIS conversation started — including
 *  those its delegated sub-agents started, which are its work too. Each row opens a live-output modal on
 *  click and carries an ✕ to kill it. Hidden when there are none. The query is owner-wide (every process
 *  the user owns across sessions), so the transcript panel narrows to the open conversation — a job from
 *  another chat or a channel is noise here. Those stay reachable, and killable, in the telemetry rail's
 *  separate "other processes" section, so an orphaned delegate's leftover service is never stranded. */
export function ProcessPanel({ owned }: { owned: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: allProcesses = [] } = useBrainProcesses();
  const procs = allProcesses.filter((p) => isOwnProcess(p, owned));
  // Track the open modal by id, not a click-time snapshot, so `proc.running` reflects the LIVE state from
  // the polled list — the modal stops polling once the process exits (and closes if it's pruned away).
  const [openId, setOpenId] = useState<string | null>(null);
  const openProc = procs.find((p) => p.id === openId) ?? null;
  if (procs.length === 0) return null;

  const kill = async (id: string) => {
    await elowenClient.brainKillProcess(id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['brain-processes'] });
  };
  const runningCount = procs.filter((p) => p.running).length;

  return (
    <div className="flex flex-col pl-4 font-mono text-tiny leading-relaxed">
      <div className="flex items-center gap-1.5 text-text-muted">
        <TerminalSquare size={11} aria-hidden /> {t.processes.title}
        <span className="tabular-nums opacity-70">{runningCount}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {procs.map((p) => (
          <li key={p.id} className="group flex items-center gap-1.5">
            <span className={`shrink-0 ${p.running ? 'text-success' : 'text-text-muted'}`} title={p.running ? t.processes.running : t.processes.exited}>●</span>
            <button
              type="button"
              onClick={() => setOpenId(p.id)}
              className="min-w-0 flex-1 truncate text-left font-mono text-text hover:underline"
              title={p.command}
            >
              {p.command}
            </button>
            <button
              type="button"
              onClick={() => void kill(p.id)}
              aria-label={t.processes.kill}
              title={t.processes.kill}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-muted opacity-0 transition-all hover:text-danger group-hover:opacity-100"
            >
              <X size={11} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {openProc ? <ProcessOutputModal proc={openProc} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
