import { visibleWidth } from '@earendil-works/pi-tui';
import type { Component, Editor, Focusable, TUI } from '@earendil-works/pi-tui';
import { isEscapeKey, isKeyRelease, isLeftKey, isRightKey } from './keys.js';
import { color } from './theme.js';
import { FRAME_COLS, framed, hintRow, sectionRule, sectionTabs, titleRow } from './modalFrame.js';
import { openCenteredModal } from './openCenteredModal.js';
import { formatK } from '../ui/text.js';
import type { ModelUsageView, BrainUsageView } from './brainClient.js';
import type { BrainContextBreakdown, BrainContextCategoryId } from '../../shared/wireContract.js';

interface StatsOverlayData {
  model: string | null;
  usage: BrainUsageView | null;
  models: ModelUsageView[];
  /** What is filling the window right now; null when no live session could be measured. */
  context: BrainContextBreakdown | null;
}

type Section = 'conversation' | 'models' | 'context';

const SECTIONS: readonly Section[] = ['conversation', 'models', 'context'];

/** Human labels for the breakdown's closed category set — the CLI's own chrome, English like the rest. */
const CATEGORY_LABEL: Record<BrainContextCategoryId, string> = {
  system: 'system',
  tools: 'tools',
  user: 'you',
  assistant: 'assistant',
  toolResults: 'tool output',
  other: 'other',
};

/** Right-aligned label + value pair — the calm two-column grid all etched modals share. */
const LABEL_W = 10;
const kv = (label: string, value: string): string => ` ${color.dim(label.padStart(LABEL_W))}   ${value}`;

function contextBar(width: number, percent: number): string {
  const on = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return color.text('▰'.repeat(on)) + color.faint('▱'.repeat(width - on));
}

class StatsOverlay implements Component, Focusable {
  private _focused = false;
  private section: Section;

  constructor(
    private readonly data: StatsOverlayData,
    private readonly onClose: () => void,
    section: Section = 'conversation',
  ) {
    this.section = section;
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }
  invalidate(): void { /* state driven */ }

  private cycle(step: 1 | -1): void {
    const at = SECTIONS.indexOf(this.section);
    const next = SECTIONS[(at + step + SECTIONS.length) % SECTIONS.length];
    if (next) this.section = next;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (isEscapeKey(data)) { this.onClose(); return; }
    if (isLeftKey(data)) { this.cycle(-1); return; }
    if (isRightKey(data)) { this.cycle(1); return; }
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - FRAME_COLS);
    const { model, usage, models } = this.data;

    const body: string[] = [];
    body.push('');
    const tabs = sectionTabs([
      { label: 'Conversation', active: this.section === 'conversation' },
      { label: 'Models', active: this.section === 'models' },
      { label: 'Context', active: this.section === 'context' },
    ]);
    body.push(titleRow('Stats', tabs.text, bodyWidth, tabs.width));
    body.push('');

    if (this.section === 'conversation') {
      body.push(sectionRule('session', bodyWidth));
      body.push('');
      const u = usage;
      if (u) {
        body.push(kv('model', color.text(model || '—')));
        if (u.percent != null) {
          body.push(kv('context', color.text(`${Math.round(u.percent)}%`) + color.faint(`   ${formatK(u.tokens ?? 0)} / ${formatK(u.contextWindow)}`)));
          body.push(kv('', contextBar(Math.min(34, Math.max(10, bodyWidth - LABEL_W - 6)), u.percent)));
        }
        body.push('');
        body.push(sectionRule('usage', bodyWidth));
        body.push('');
        body.push(kv('tokens', color.text(`${formatK(u.totalTokens)} total`)));
        if (u.input != null || u.output != null) {
          body.push(kv('in / out', color.faint(`${formatK(u.input ?? 0)} / ${formatK(u.output ?? 0)}`)));
        }
        // Hit rate = share of INPUT tokens served from cache. The denominator is the whole input —
        // fresh input + cacheRead + cacheWrite — because cacheWrite tokens were NOT in the cache (they
        // had to be written), so they are misses. Omitting them overstates the rate (a warm turn with a
        // small write reads as ~100%). Two decimals, not Math.round, so 99.55% doesn't round up to 100%.
        {
          const cacheDenom = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
          if (u.cacheRead != null && cacheDenom > 0) {
            body.push(kv('cache hit', color.faint(`${((u.cacheRead / cacheDenom) * 100).toFixed(2)}%`)));
          }
        }
        body.push(kv('cost', color.bold(color.text(`$${u.cost.toFixed(2)}`))));
        if (u.outputTps != null && u.outputTps > 0) {
          body.push(kv('speed', color.text(`${Math.round(u.outputTps)} tok/s`)));
        }
      } else {
        body.push(kv('', color.faint('no conversation usage data')));
      }
    } else if (this.section === 'context') {
      this.renderContext(body, bodyWidth);
    } else {
      body.push(sectionRule('per model', bodyWidth));
      body.push('');
      if (models.length === 0) {
        body.push(kv('', color.faint('no model usage data')));
      } else {
        const execW = 26, tokW = 10, cacheW = 10, tpsW = 8, costW = 10;
        const pad = '   ';
        body.push(`${pad}${color.dim('model'.padEnd(execW))}${color.dim('tokens'.padStart(tokW))}${color.dim('cache'.padStart(cacheW))}${color.dim('tok/s'.padStart(tpsW))}${color.dim('cost'.padStart(costW))}`);

        const sorted = [...models].sort((a, b) => b.usage.total - a.usage.total);
        for (const m of sorted) {
          const exec = m.exec.length > execW - 2 ? `${m.exec.slice(0, execW - 4)}…` : m.exec;
          const costStr = m.usage.costUsd != null ? `$${m.usage.costUsd.toFixed(2)}` : '—';
          const tpsStr = m.usage.outputTps != null && m.usage.outputTps > 0 ? `${Math.round(m.usage.outputTps)}` : '—';
          body.push(`${pad}${color.text(exec.padEnd(execW))}${color.text(formatK(m.usage.total).padStart(tokW))}${color.faint(formatK(m.usage.cacheRead + m.usage.cacheWrite).padStart(cacheW))}${color.faint(tpsStr.padStart(tpsW))}${color.text(costStr.padStart(costW))}`);
        }

        const totalTokens = models.reduce((sum, m) => sum + m.usage.total, 0);
        const totalCache = models.reduce((sum, m) => sum + m.usage.cacheRead + m.usage.cacheWrite, 0);
        const costs = models.map((m) => m.usage.costUsd).filter((c): c is number => c != null);
        const totalCost = costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;
        // Duration-weighted average speed across the models that measured one — a model's seconds are its
        // MEASURED output over its rate; total `output` would overweight untimed history.
        let measuredOutput = 0, measuredSeconds = 0;
        for (const m of models) {
          const tps = m.usage.outputTps;
          const measured = m.usage.measuredOutput ?? 0;
          if (tps != null && tps > 0 && measured > 0) { measuredOutput += measured; measuredSeconds += measured / tps; }
        }
        const avgTps = measuredSeconds > 0 ? `${Math.round(measuredOutput / measuredSeconds)}` : '—';
        body.push(`${pad}${color.faint('─'.repeat(execW + tokW + cacheW + tpsW + costW))}`);
        body.push(`${pad}${color.accent('Σ'.padEnd(execW))}${color.text(formatK(totalTokens).padStart(tokW))}${color.faint(formatK(totalCache).padStart(cacheW))}${color.faint(avgTps.padStart(tpsW))}${color.bold(color.text((totalCost != null ? `$${totalCost.toFixed(2)}` : '—').padStart(costW)))}`);
      }
    }

    body.push('');
    body.push(hintRow('← → section · esc close'));
    return framed(body, width);
  }

  /** "What is filling the window": one bar per measured category, then the heaviest tools. Every figure
   *  here is an estimate (the daemon has no provider tokenizer), so the window line names the provider's
   *  own count separately instead of blending the two into one authoritative-looking number. */
  private renderContext(body: string[], bodyWidth: number): void {
    const breakdown = this.data.context;
    body.push(sectionRule('window', bodyWidth));
    body.push('');
    if (!breakdown) {
      body.push(kv('', color.faint('no live session to measure')));
      return;
    }
    const barWidth = Math.min(34, Math.max(10, bodyWidth - LABEL_W - 6));
    body.push(kv('model', color.text(breakdown.model || '—')));
    body.push(kv('window', color.text(formatK(breakdown.contextWindow))
      + (breakdown.compactAtTokens != null ? color.faint(`   compacts at ${formatK(breakdown.compactAtTokens)}`) : '')));
    if (breakdown.reportedTokens != null) {
      body.push(kv('reported', color.text(formatK(breakdown.reportedTokens))
        + color.faint('   provider count, last request')));
    }
    body.push('');
    body.push(sectionRule('estimated breakdown', bodyWidth));
    body.push('');
    if (breakdown.categories.length === 0) {
      body.push(kv('', color.faint('nothing measured yet')));
    } else {
      for (const category of breakdown.categories) {
        body.push(kv(CATEGORY_LABEL[category.id], color.text(formatK(category.tokens).padStart(6))
          + color.faint(`  ${Math.round(category.percent)}%`)));
        body.push(kv('', contextBar(barWidth, category.percent)));
      }
      body.push(kv('free', color.faint(`${formatK(breakdown.free.tokens).padStart(6)}  ${Math.round(breakdown.free.percent)}%`)));
    }
    if (breakdown.tools.length > 0) {
      body.push('');
      body.push(sectionRule('heaviest tools', bodyWidth));
      body.push('');
      const nameW = 22, tokW = 8;
      const pad = '   ';
      body.push(`${pad}${color.dim('tool'.padEnd(nameW))}${color.dim('tokens'.padStart(tokW))}${color.dim('   schema / calls / output')}`);
      for (const tool of breakdown.tools) {
        const name = tool.name.length > nameW - 2 ? `${tool.name.slice(0, nameW - 4)}…` : tool.name;
        const detail = `${formatK(tool.schemaTokens)} / ${formatK(tool.callTokens)} / ${formatK(tool.resultTokens)}`;
        body.push(`${pad}${color.text(name.padEnd(nameW))}${color.text(formatK(tool.tokens).padStart(tokW))}${color.faint(`   ${detail}`)}`);
      }
    }
  }
}

/** Fetch data then open the stats overlay with ←→-switchable Conversation/Models/Context sections.
 *  `section` picks the one to land on — `/stats` opens on the conversation, `/context` on the breakdown. */
export function openStatsOverlay(o: {
  tui: TUI;
  editor: Editor;
  data: StatsOverlayData;
  section?: Section;
}): void {
  const longest = Math.max(
    62,
    ...o.data.models.map((m) => Math.min(m.exec.length, 26) + 10 + 10 + 8 + 10 + 6),
    visibleWidth('Stats        ● Conversation    ○ Models    ○ Context') + 8,
  );
  openCenteredModal({
    tui: o.tui,
    editor: o.editor,
    makeComponent: (close) => new StatsOverlay(o.data, close, o.section),
    longest,
    minWidth: 56,
    pad: 8,
    maxHeight: 20,
  });
}
