import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Highlighter, Span } from './highlight';

export { Highlighter } from './highlight';

// Minimal slice of the built-in git extension API (vscode.git/src/api/git.d.ts).
interface GitAPI {
  git: { path: string };
  getRepository(uri: vscode.Uri): { rootUri: vscode.Uri } | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension { getAPI(version: 1): GitAPI; }

export interface Hunk { oldStart: number; oldLen: number; newStart: number; newLen: number; }
export interface LineRange { start: number; end: number; } // 1-based, inclusive
export interface DiffLine { kind: 'ctx' | 'add' | 'del'; text: string; }
export interface DiffHunk extends Hunk { context: string; lines: DiffLine[]; }
export interface Patch { oldPath: string; newPath: string; hunks: DiffHunk[]; }

/** Where a side of a diff comes from: a revision, the index, or the working tree. */
export interface Side { type: 'rev' | 'index' | 'worktree'; ref?: string; path: string; }

export interface Entry {
  id: string;
  kind: 'commit' | 'unstaged' | 'staged';
  short: string;
  author: string;
  ago: string;
  date: string;
  subject: string;
  body: string;
  parents: string[];
  left?: Side;
  right: Side;
  hunks: DiffHunk[];
}

interface PanelState {
  title: string;
  status: 'loading' | 'ready' | 'error';
  message?: string;
  entries: Entry[];
}

/** What the panel needs to serve one lookup, including cached reads of the file's sides. */
interface PanelContext {
  repoRoot: vscode.Uri;
  git: GitAPI;
  languageId: string;
  read(side: Side): Promise<string | undefined>;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const VIEW_ID = 'selectionHistory.panel';
const DIFF_OPTS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

let panel: PanelProvider;

export function activate(context: vscode.ExtensionContext) {
  const highlighter = new Highlighter(path.join(context.extensionPath, 'out', 'onig.wasm'));
  panel = new PanelProvider(context.extensionUri, highlighter);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    vscode.window.onDidChangeActiveColorTheme(() => { highlighter.reset(); panel.themeChanged(); }),
    vscode.commands.registerCommand('selectionHistory.show', () => show().catch(async err => {
      const message = err instanceof Error ? err.message : String(err);
      panel.update({ title: 'History for Selection', status: 'error', message, entries: [] });
      await panel.reveal();
    }))
  );
}

async function show() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('Open a file on disk first.');
    return;
  }
  const document = editor.document;
  if (document.isDirty) {
    const choice = await vscode.window.showWarningMessage(
      'The file has unsaved changes. Save it to look up history?', { modal: true }, 'Save and continue');
    if (choice !== 'Save and continue') { return; }
    await document.save();
  }

  const git = getGitApi();
  const repo = git.getRepository(document.uri);
  if (!repo) {
    vscode.window.showInformationMessage('This file is not inside a Git repository.');
    return;
  }
  const root = repo.rootUri.fsPath;
  const relPath = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
  const exec = (args: string[]) => run(git.git.path, root, args);
  const read = sideReader(git.git.path, root);

  const fail = async (message: string) => {
    panel.update({ title: relPath, status: 'error', message, entries: [] });
    await panel.reveal();
  };

  const [tracked, unstagedText, stagedText] = await Promise.all([
    exec(['ls-files', '--', relPath]),
    exec(['diff', '-U0', ...DIFF_OPTS, '--', relPath]),
    exec(['diff', '-U0', ...DIFF_OPTS, '--cached', '--', relPath]),
  ]);
  if (!tracked.trim()) {
    await fail('This file is not tracked by Git yet.');
    return;
  }

  // Ranges in the working tree (1-based, inclusive).
  const wtRanges: LineRange[] = editor.selections.map(sel => {
    let end = sel.end.line;
    if (!sel.isEmpty && sel.end.character === 0 && end > sel.start.line) { end--; }
    return { start: sel.start.line + 1, end: end + 1 };
  });

  // Working tree -> index -> HEAD. git log -L addresses lines in HEAD's version of the file.
  const unstaged = parsePatch(unstagedText, relPath).hunks;
  const staged = parsePatch(stagedText, relPath).hunks;
  const indexRanges = wtRanges.map(r => mapRangeThrough(r, unstaged)).filter((r): r is LineRange => r !== null);
  const headRanges = indexRanges.map(r => mapRangeThrough(r, staged)).filter((r): r is LineRange => r !== null);

  const entries: Entry[] = [];
  const worktreeSide: Side = { type: 'worktree', path: relPath };
  const indexSide: Side = { type: 'index', path: relPath };
  const headSide: Side = { type: 'rev', ref: 'HEAD', path: relPath };
  const splitLines = (text: string | undefined) => (text ?? '').split(/\r?\n/);
  if (unstaged.some(h => wtRanges.some(r => intersects(h, r)))) {
    const [oldText, newText] = await Promise.all([read(indexSide), read(worktreeSide)]);
    const hunks = wtRanges.map(r => windowHunk(r, unstaged, splitLines(oldText), splitLines(newText)));
    entries.push(workingEntry('unstaged', 'Unstaged changes', indexSide, worktreeSide, hunks));
  }
  if (staged.some(h => indexRanges.some(r => intersects(h, r)))) {
    const [oldText, newText] = await Promise.all([read(headSide), read(indexSide)]);
    const hunks = indexRanges.map(r => windowHunk(r, staged, splitLines(oldText), splitLines(newText)));
    entries.push(workingEntry('staged', 'Staged changes', headSide, indexSide, hunks));
  }
  if (headRanges.length === 0 && entries.length === 0) {
    await fail('The selected lines have no history yet.');
    return;
  }

  const fmt = (r: LineRange) => r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`;
  const title = `${relPath} ${wtRanges.map(fmt).join(', ')}`;
  panel.setContext({ repoRoot: repo.rootUri, git, languageId: document.languageId, read });
  panel.update({ title, status: 'loading', entries: [] });
  await panel.reveal();

  if (headRanges.length) {
    const max = vscode.workspace.getConfiguration('selectionHistory').get<number>('maxCommits', 200);
    const args = ['log', ...DIFF_OPTS, '-n', String(max),
      '--format=%x1e%H%x00%h%x00%an%x00%ar%x00%as%x00%P%x00%s%x00%b%x1f'];
    for (const r of headRanges) { args.push('-L', `${r.start},${r.end}:${relPath}`); }
    entries.push(...parseLog(await exec(args), relPath));
  }
  panel.update({ title, status: 'ready', entries });
}

function workingEntry(kind: 'unstaged' | 'staged', subject: string, left: Side, right: Side, hunks: DiffHunk[]): Entry {
  return { id: kind, kind, short: '', author: '', ago: 'now', date: '', subject, body: '', parents: [], left, right, hunks };
}

class PanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: PanelState = { title: 'History for Selection', status: 'ready', entries: [] };
  private ctx?: PanelContext;

  constructor(private readonly extensionUri: vscode.Uri, private readonly highlighter: Highlighter) {}

  setContext(ctx: PanelContext) { this.ctx = ctx; }

  update(state: PanelState) {
    this.state = state;
    this.view?.webview.postMessage({ type: 'state', state });
  }

  themeChanged() { this.view?.webview.postMessage({ type: 'theme' }); }

  async reveal() {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.view?.webview.postMessage({ type: 'focus' });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;

    view.webview.onDidReceiveMessage(async (msg: { type: string; id?: string }) => {
      switch (msg.type) {
        case 'ready':
          this.update(this.state);
          break;
        case 'openDiff': {
          const entry = this.state.entries.find(e => e.id === msg.id);
          if (entry && this.ctx) { await openNativeDiff(this.ctx.git, this.ctx.repoRoot, entry); }
          break;
        }
        case 'tokens': {
          const entry = this.state.entries.find(e => e.id === msg.id);
          const ctx = this.ctx;
          if (!entry || !ctx) { break; }
          const [left, right] = await Promise.all([
            entry.left ? this.sideTokens(ctx, entry.left, sideRanges(entry.hunks, 'old')) : {},
            this.sideTokens(ctx, entry.right, sideRanges(entry.hunks, 'new')),
          ]);
          view.webview.postMessage({ type: 'tokens', id: entry.id, left, right });
          break;
        }
        case 'focusEditor':
          await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
          break;
      }
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  private async sideTokens(ctx: PanelContext, side: Side, ranges: LineRange[]): Promise<Record<number, Span[]>> {
    if (!ranges.length) { return {}; }
    const content = await ctx.read(side);
    if (content === undefined) { return {}; }
    const lines = content.split(/\r?\n/);
    const upTo = Math.max(...ranges.map(r => r.end));
    const spans = await this.highlighter.tokenize(ctx.languageId, lines, upTo);
    if (!spans) { return {}; }
    const out: Record<number, Span[]> = {};
    for (const r of ranges) {
      for (let n = r.start; n <= r.end; n++) { if (spans[n - 1]) { out[n] = spans[n - 1]; } }
    }
    return out;
  }
}

/** Reads the full text of a file from a revision, the index, or the working tree, once per side. */
function sideReader(gitPath: string, root: string): PanelContext['read'] {
  const cache = new Map<string, Promise<string | undefined>>();
  return side => {
    const key = `${side.type}:${side.ref ?? ''}:${side.path}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (side.type === 'worktree'
        ? fs.promises.readFile(path.join(root, side.path), 'utf8')
        : run(gitPath, root, ['show', `${side.type === 'index' ? '' : side.ref}:${side.path}`])
      ).catch(() => undefined);
      cache.set(key, pending);
    }
    return pending;
  };
}

/**
 * Build one hunk that covers `range` (new-side numbering) in full: unchanged lines as context,
 * with the changes from `hunks` (a -U0 diff) marked inside it. `oldLines`/`newLines` are the
 * complete contents of the two sides.
 */
export function windowHunk(range: LineRange, hunks: Hunk[], oldLines: string[], newLines: string[]): DiffHunk {
  const out: DiffHunk = { oldStart: 0, oldLen: 0, newStart: range.start, newLen: 0, context: '', lines: [] };
  let oldNo = 1, newNo = 1, k = 0;
  let firstOld: number | undefined;
  const emit = (kind: DiffLine['kind'], text: string, old?: number) => {
    if (old !== undefined && firstOld === undefined) { firstOld = old; }
    out.lines.push({ kind, text });
    if (kind !== 'add') { out.oldLen++; }
    if (kind !== 'del') { out.newLen++; }
  };
  // A pure deletion sits between new lines, so one just after `range.end` still belongs to it.
  while (newNo <= range.end + 1) {
    const h = hunks[k];
    const atHunk = h && (h.newLen > 0 ? newNo === h.newStart : newNo === h.newStart + 1);
    if (atHunk) {
      const inWindow = intersects(h, range);
      for (let i = 0; i < h.oldLen; i++) {
        if (inWindow) { emit('del', oldLines[oldNo + i - 1] ?? '', oldNo + i); }
      }
      oldNo += h.oldLen;
      for (let i = 0; i < h.newLen; i++) {
        const n = newNo + i;
        if (n >= range.start && n <= range.end) {
          if (firstOld === undefined) { firstOld = oldNo; }
          emit('add', newLines[n - 1] ?? '');
        }
      }
      newNo += h.newLen;
      k++;
      continue;
    }
    if (newNo >= range.start && newNo <= range.end) { emit('ctx', newLines[newNo - 1] ?? '', oldNo); }
    oldNo++;
    newNo++;
  }
  out.oldStart = firstOld ?? oldNo;
  return out;
}

/** The lines each hunk occupies on one side; hunks with nothing on that side are skipped. */
export function sideRanges(hunks: Hunk[], side: 'old' | 'new'): LineRange[] {
  return hunks.flatMap(h => {
    const [start, len] = side === 'old' ? [h.oldStart, h.oldLen] : [h.newStart, h.newLen];
    return len > 0 ? [{ start, end: start + len - 1 }] : [];
  });
}

async function openNativeDiff(git: GitAPI, repoRoot: vscode.Uri, entry: Entry) {
  const uriFor = (s: Side) => {
    const file = vscode.Uri.joinPath(repoRoot, s.path);
    return s.type === 'worktree' ? file : git.toGitUri(file, s.type === 'index' ? '' : s.ref ?? 'HEAD');
  };
  const right = uriFor(entry.right);
  const touched = sideRanges(entry.hunks, 'new');
  const options: vscode.TextDocumentShowOptions = {
    preview: true,
    viewColumn: vscode.ViewColumn.Active,
    selection: touched.length
      ? new vscode.Range(Math.min(...touched.map(r => r.start)) - 1, 0, Math.max(...touched.map(r => r.end)) - 1, Number.MAX_SAFE_INTEGER)
      : undefined,
  };
  if (!entry.left) {
    await vscode.commands.executeCommand('vscode.open', right, options);
    return;
  }
  const name = path.basename(entry.right.path);
  const title = entry.kind === 'commit'
    ? `${name} (${entry.parents[0].slice(0, 7)} vs ${entry.short}) ${entry.subject}`
    : `${name} (${entry.subject})`;
  await vscode.commands.executeCommand('vscode.diff', uriFor(entry.left), right, title, options);
}

function getGitApi(): GitAPI {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) { throw new Error('The built-in Git extension is not available.'); }
  return ext.exports.getAPI(1);
}

function run(gitPath: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitPath || 'git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
    });
  });
}

/** Parse one unified diff (a single file) into hunks with their lines. */
export function parsePatch(text: string, fallbackPath: string): Patch {
  const patch: Patch = { oldPath: fallbackPath, newPath: fallbackPath, hunks: [] };
  let current: DiffHunk | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('--- a/')) { patch.oldPath = line.slice(6); current = undefined; }
    else if (line.startsWith('+++ b/')) { patch.newPath = line.slice(6); current = undefined; }
    else if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) { continue; }
      current = {
        oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4],
        context: m[5] ?? '', lines: [],
      };
      patch.hunks.push(current);
    }
    else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      const kind = line[0] === ' ' ? 'ctx' : line[0] === '+' ? 'add' : 'del';
      current.lines.push({ kind, text: line.slice(1) });
    }
    else if (line.startsWith('diff --git')) { current = undefined; }
  }
  return patch;
}

/** Does a hunk (in "new side" numbering) touch the given range? Pure deletions count if they sit inside it. */
export function intersects(h: Hunk, r: LineRange): boolean {
  if (h.newLen === 0) { return r.start - 1 <= h.newStart && h.newStart <= r.end; }
  return h.newStart <= r.end && h.newStart + h.newLen - 1 >= r.start;
}

/**
 * Map a "new side" line number to the "old side" through a set of hunks.
 * A line inside a modification maps to the old line it replaced (clamped to the hunk);
 * a line inside a pure insertion has no old counterpart and yields null.
 */
export function mapLineThrough(line: number, hunks: Hunk[]): number | null {
  let offset = 0;
  for (const h of hunks) {
    if (h.newLen === 0) { // pure deletion after newStart
      if (line > h.newStart) { offset += h.oldLen; continue; }
      break;
    }
    if (line < h.newStart) { break; }
    if (line < h.newStart + h.newLen) {
      return h.oldLen === 0 ? null : h.oldStart + Math.min(line - h.newStart, h.oldLen - 1);
    }
    offset += h.oldLen - h.newLen;
  }
  return line + offset;
}

export function mapRangeThrough(range: LineRange, hunks: Hunk[]): LineRange | null {
  let start: number | null = null;
  let end: number | null = null;
  for (let l = range.start; l <= range.end && start === null; l++) { start = mapLineThrough(l, hunks); }
  for (let l = range.end; l >= range.start && end === null; l--) { end = mapLineThrough(l, hunks); }
  if (start === null || end === null) { return null; }
  return { start, end: Math.max(start, end) };
}

export function parseLog(output: string, fallbackPath: string): Entry[] {
  const entries: Entry[] = [];
  for (const record of output.split('\x1e')) {
    if (!record.trim()) { continue; }
    const sep = record.indexOf('\x1f');
    const header = sep === -1 ? record : record.slice(0, sep);
    const patchText = sep === -1 ? '' : record.slice(sep + 1);
    const [sha, short, author, ago, date, parents, subject, body] = header.split('\x00');
    const parentList = parents ? parents.split(' ').filter(Boolean) : [];
    const patch = parsePatch(patchText, fallbackPath);
    entries.push({
      id: sha, kind: 'commit', short, author, ago, date, subject: subject ?? '', body: (body ?? '').trim(),
      parents: parentList,
      left: parentList.length ? { type: 'rev', ref: parentList[0], path: patch.oldPath } : undefined,
      right: { type: 'rev', ref: sha, path: patch.newPath },
      hunks: patch.hunks,
    });
  }
  return entries;
}
