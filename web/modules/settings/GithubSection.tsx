'use client';
import { useEffect, useState } from 'react';
import { GitPullRequest, GitBranch, TerminalSquare, KeyRound } from 'lucide-react';
import { GithubStatusBanner } from './GithubStatusBanner';
import { SettingsGroup, SettingsRow } from './SettingsSurface';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useToast } from '../../components/ui/Toast';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

/** Settings → GitHub: the PR workflow defaults and the write-only token, auto-persisted per field. */
export function GithubSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data: config } = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [ghToken, setGhToken] = useState('');
  const [prEnabled, setPrEnabled] = useState(false);
  const [prBaseBranch, setPrBaseBranch] = useState('');
  const [prAutoOpen, setPrAutoOpen] = useState(false);
  const [prVerifyCommand, setPrVerifyCommand] = useState('');
  // The GitHub text fields edit in one side drawer opened via pod orbs.
  const [githubOpen, setGithubOpen] = useState(false);

  // Seed once from the config. useConfig is stale-while-revalidate, so it refetches on window focus;
  // re-seeding on every refetch would wipe a field the user just edited before the autosave fires.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (config && !seeded) {
      setSeeded(true);
      setPrEnabled(config.autopilot.prEnabled ?? false);
      setPrBaseBranch(config.autopilot.prBaseBranch ?? '');
      setPrAutoOpen(config.autopilot.prAutoOpen ?? false);
      setPrVerifyCommand(config.autopilot.prVerifyCommand ?? '');
    }
  }, [config, seeded]);

  // GitHub / PR-native settings live in their own section. The global prEnabled is the DEFAULT for new
  // projects; each project can override it. The ghToken is write-only — sent only when freshly typed.
  const saveGithub = async () => {
    try {
      await update.mutateAsync({ autopilot: { prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ...(ghToken ? { ghToken } : {}) } });
      if (ghToken) setGhToken('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };

  const { status, retry } = useAutoSaveStatus([prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ghToken], saveGithub, { ready: seeded });
  useEffect(() => {
    onSaveState?.('github', status, status === 'error' ? retry : undefined);
  }, [status, onSaveState, retry]);

  const ghTokenSet = config?.autopilot.ghTokenSet ?? false;

  return (
    <>
      {/* variant="classic": the status banner is not a label/control row. */}
      <SettingsGroup variant="classic"><GithubStatusBanner /></SettingsGroup>
      <SettingsGroup>
      {/* The three text fields show as chips in the orbit and edit together in one side
          drawer (opened via any of their pod orbs); toggles stay inline. */}
      <SettingsRow label={t.settings.ghToken} description={ghTokenSet ? t.help.ghToken : t.help.ghTokenNotSet} icon={KeyRound}>
        <span className="font-mono text-sm tracking-widest text-text-muted">{ghTokenSet || ghToken ? '••••••••' : '—'}</span>
        <button type="button" data-selection-manage className="hidden" aria-label={t.settings.ghToken} onClick={() => setGithubOpen(true)} />
      </SettingsRow>
      <SettingsRow label={t.settings.prEnabled} description={t.help.prEnabled} icon={GitPullRequest}>
        <Toggle checked={prEnabled} onChange={setPrEnabled} label={t.settings.prEnabled} />
      </SettingsRow>
      <SettingsRow label={t.settings.prBaseBranch} description={t.help.prBaseBranch} icon={GitBranch}>
        <span className="max-w-full truncate font-mono text-sm text-text-muted">{prBaseBranch || t.settings.prBaseBranchPlaceholder}</span>
        <button type="button" data-selection-manage className="hidden" aria-label={t.settings.prBaseBranch} onClick={() => setGithubOpen(true)} />
      </SettingsRow>
      <SettingsRow label={t.settings.prAutoOpen} description={t.help.prAutoOpen} icon={GitPullRequest}>
        <Toggle checked={prAutoOpen} onChange={setPrAutoOpen} label={t.settings.prAutoOpen} />
      </SettingsRow>
      <SettingsRow label={t.settings.prVerifyCommand} description={t.help.prVerifyCommand} icon={TerminalSquare}>
        <span className="max-w-full truncate font-mono text-sm text-text-muted">{prVerifyCommand || '—'}</span>
        <button type="button" data-selection-manage className="hidden" aria-label={t.settings.prVerifyCommand} onClick={() => setGithubOpen(true)} />
      </SettingsRow>
      </SettingsGroup>
      {githubOpen ? (
        <WorkspaceDetailRail label={t.settings.github} closeLabel={t.common.close} onClose={() => setGithubOpen(false)}>
          <div className="flex flex-col gap-5 py-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.ghToken}</span>
              <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? t.settings.apiKeySetPlaceholder : t.settings.ghTokenPlaceholder} className={inputClass} aria-label={t.settings.ghToken} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.prBaseBranch}</span>
              <input value={prBaseBranch} onChange={(e) => setPrBaseBranch(e.target.value)} placeholder={t.settings.prBaseBranchPlaceholder} className={inputClass} aria-label={t.settings.prBaseBranch} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.prVerifyCommand}</span>
              <input value={prVerifyCommand} onChange={(e) => setPrVerifyCommand(e.target.value)} placeholder={t.settings.prVerifyCommandPlaceholder} className={`${inputClass} font-mono text-xs`} aria-label={t.settings.prVerifyCommand} />
            </div>
          </div>
        </WorkspaceDetailRail>
      ) : null}
    </>
  );
}
