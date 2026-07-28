import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';

// Monaco is browser-only — stub it with a textarea and capture the Cmd+S command the editor
// registers via `onMount`, so a test can save exactly the way a keyboard user does (the toolbar
// Save button is disabled while a write is pending; Cmd+S is not).
const monaco = vi.hoisted(() => ({ save: (() => {}) as () => void }));
vi.mock('../../../modules/projects/editor/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange, onMount }: {
    value: string;
    onChange: (v: string | undefined) => void;
    onMount: (editor: { addCommand: (key: number, cb: () => void) => void }, m: { KeyMod: { CtrlCmd: number }; KeyCode: { KeyS: number } }) => void;
  }) => {
    onMount({ addCommand: (_key, cb) => { monaco.save = cb; } }, { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } });
    return <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />;
  },
  MonacoDiffEditor: () => null,
}));

// The saved content never comes back through this mock: it stands in for the server-side state the
// editor falls back to once it retires its local draft.
const SERVER_CONTENT = 'line one\n';
vi.mock('../../../lib/queries', async (orig) => ({
  ...(await orig() as object),
  useProjectFiles: () => ({ data: [{ path: 'a.ts', type: 'file' }], isLoading: false }),
  useProjectFile: () => ({ data: { content: SERVER_CONTENT, truncated: false }, isLoading: false }),
  useProjectFileAtHead: () => ({ data: { content: SERVER_CONTENT }, isLoading: false }),
  useProjectCommit: () => ({ data: undefined, isLoading: false }),
  useProjectCommitFileDiff: () => ({ data: undefined, isLoading: false }),
  useProjectChanged: () => ({ data: { changed: [] }, isLoading: false }),
  useProjectChanges: () => ({ data: undefined, isLoading: false }),
}));

import { ProjectEditor } from '../../../modules/projects/editor/ProjectEditor';

// The write is held open so the test can type while it is in flight.
let release: (() => void) | null = null;
const server = setupServer(
  http.put('*/api/projects/:id/file', async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return HttpResponse.json({ ok: true });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => { release = null; });
afterAll(() => server.close());

function renderEditor() {
  const { wrapper: Base } = createWrapper();
  const Wrapper = ({ children }: { children: ReactNode }) => <Base><ToastProvider>{children}</ToastProvider></Base>;
  render(<ProjectEditor projectId={5} />, { wrapper: Wrapper });
  fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
  return screen.getByLabelText('editor') as HTMLTextAreaElement;
}

describe('ProjectEditor save', () => {
  it('keeps edits typed while the save is in flight', async () => {
    const editor = renderEditor();

    fireEvent.change(editor, { target: { value: 'saved text\n' } });
    act(() => monaco.save());
    await waitFor(() => expect(release).not.toBeNull());

    // The user keeps typing before the write comes back.
    fireEvent.change(editor, { target: { value: 'saved text\nstill typing\n' } });
    act(() => { release?.(); });
    await screen.findByText('Saved a.ts');

    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('saved text\nstill typing\n');
    // …and the file is still dirty, so the newer text can actually be saved.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('retires the draft when nothing changed during the save', async () => {
    const editor = renderEditor();

    fireEvent.change(editor, { target: { value: 'saved text\n' } });
    act(() => monaco.save());
    await waitFor(() => expect(release).not.toBeNull());
    act(() => { release?.(); });
    await screen.findByText('Saved a.ts');

    // Draft gone → the pane falls back to the server content and the file is clean again.
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe(SERVER_CONTENT);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
