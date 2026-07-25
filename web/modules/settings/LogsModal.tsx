'use client';
import { useMemo, useState } from 'react';
import { ScrollText, Trash2, RefreshCw } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/states';
import { MonacoEditor } from '../projects/editor/monacoLoader';
import { defineEditorThemes } from '../projects/editor/oledTheme';
import { useLogFiles, useLogFile } from '../../lib/queries';
import { useDeleteLogFile, useDeleteAllLogFiles } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { parseLogLines, filterLogLines, formatLogSize, LOG_LEVELS, type LogLevel } from './logFilter';

/** Line count asked for when the user opts out of the default tail. Matches the daemon's own ceiling. */
const FULL_FILE_LINES = 50_000;

/** Level chip tint — the same severity palette the plugin log panel uses. */
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'text-text-muted/70',
  info: 'text-text-muted',
  warn: 'text-warning',
  error: 'text-danger',
};

/** Read-only Monaco viewer for the Elowen log files: pick a file, filter it, delete what is stale. */
export function LogsModal({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<ReadonlySet<LogLevel>>(new Set<LogLevel>());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);

  const list = useLogFiles();
  const file = useLogFile(selected, full ? FULL_FILE_LINES : undefined);
  const deleteOne = useDeleteLogFile();
  const deleteAll = useDeleteAllLogFiles();

  const parsed = useMemo(() => parseLogLines(file.data?.lines ?? []), [file.data]);
  const visible = useMemo(() => filterLogLines(parsed, { query, levels }), [parsed, query, levels]);
  const text = useMemo(() => visible.map((l) => l.text).join('\n'), [visible]);

  const toggleLevel = (level: LogLevel): void => {
    setLevels((cur) => {
      const next = new Set(cur);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  };

  // Selecting a different file drops the "whole file" opt-in: it is a per-file choice, and silently
  // carrying it over would pull 50k lines of an unrelated log the user only meant to glance at.
  const pick = (name: string): void => { setSelected(name); setFull(false); };

  const files = list.data?.files ?? [];

  return (
    <>
      <Modal title={t.settings.logs} description={list.data?.dir} icon={ScrollText} onClose={onClose}>
        <div className="flex min-h-0 flex-1 gap-4 p-4">
          <div className="flex w-64 shrink-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" icon={RefreshCw} disabled={list.isFetching} onClick={() => void list.refetch()}>
                {t.settings.logsRefresh}
              </Button>
              <Button variant="danger" icon={Trash2} disabled={files.length === 0 || deleteAll.isPending} onClick={() => setDeleteAllOpen(true)}>
                {t.settings.logsDeleteAll}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              {files.length === 0 ? (
                <EmptyState title={t.settings.logsEmpty} icon={ScrollText} />
              ) : (
                files.map((f) => (
                  <div
                    key={f.name}
                    className={`flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 ${f.name === selected ? 'bg-elevated' : ''}`}
                  >
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => pick(f.name)}>
                      <div className="truncate text-xs text-text">{f.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-muted">
                        <Badge>{f.source}</Badge>
                        <span>{formatLogSize(f.bytes)}</span>
                        <span>{new Date(f.modifiedAt).toLocaleTimeString(locale)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label={t.settings.logsDeleteFile}
                      title={t.settings.logsDeleteFile}
                      className="shrink-0 text-text-muted transition-colors hover:text-danger"
                      onClick={() => setPendingDelete(f.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                placeholder={t.settings.logsSearch}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={!selected}
              />
              {LOG_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={levels.has(level)}
                  disabled={!selected}
                  onClick={() => toggleLevel(level)}
                  className={`rounded-md border px-2 py-1 text-[11px] uppercase transition-colors disabled:opacity-40 ${
                    levels.has(level) ? 'border-accent bg-elevated' : 'border-border'
                  } ${LEVEL_CLASS[level]}`}
                >
                  {level}
                </button>
              ))}
              {selected && file.data ? (
                <span className="ml-auto text-[11px] text-text-muted">
                  {t.settings.logsMatches.replace('{n}', String(visible.length)).replace('{total}', String(parsed.length))}
                </span>
              ) : null}
            </div>

            {selected && file.data?.truncated ? (
              <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-[11px] text-text-muted">
                <span>
                  {t.settings.logsTruncated
                    .replace('{n}', String(file.data.lines.length))
                    .replace('{total}', String(file.data.totalLines))}
                </span>
                <Button variant="ghost" onClick={() => setFull(true)} disabled={file.isFetching}>
                  {t.settings.logsLoadFull}
                </Button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
              {!selected ? (
                <EmptyState title={t.settings.logsPickFile} icon={ScrollText} />
              ) : (
                <MonacoEditor
                  key={selected}
                  height="100%"
                  language="plaintext"
                  theme="elowen-oled"
                  beforeMount={defineEditorThemes}
                  value={text}
                  options={{
                    readOnly: true,
                    fontSize: 12,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                    folding: false,
                    renderLineHighlight: 'none',
                    // Keep the ORIGINAL file line numbers in the gutter. Filtering removes lines, so
                    // Monaco's own 1..n would renumber the view and quietly lie about where a record
                    // actually sits in the log.
                    lineNumbers: (n: number) => String(visible[n - 1]?.n ?? ''),
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.settings.logsDeleteFileTitle}
        description={pendingDelete ? t.settings.logsDeleteFileDesc.replace('{name}', pendingDelete) : undefined}
        confirmLabel={t.common.delete}
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (!name) return;
          deleteOne.mutate(name, { onSuccess: () => { if (name === selected) setSelected(null); } });
        }}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={deleteAllOpen}
        title={t.settings.logsDeleteAllTitle}
        description={t.settings.logsDeleteAllDesc}
        confirmLabel={t.common.delete}
        onConfirm={() => {
          setDeleteAllOpen(false);
          deleteAll.mutate(undefined, { onSuccess: () => setSelected(null) });
        }}
        onClose={() => setDeleteAllOpen(false)}
      />
    </>
  );
}
