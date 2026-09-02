// Unit tests against the bundled extension: git parsing, line mapping, window hunks,
// the webview renderer (against a DOM stub) and the TextMate highlighter (against the
// grammars and themes installed with VS Code, skipped if VS Code is not installed).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'out', 'extension.js');
if (!fs.existsSync(OUT)) { console.error('Run "npm run bundle" first.'); process.exit(1); }

// ---- fixture repo ---------------------------------------------------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'selhist-'));
const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
const write = (name, lines) => fs.writeFileSync(path.join(repo, name), lines.join('\n') + '\n');
git('init', '-q');
write('f.txt', ['a', 'b', 'c', 'd', 'e', 'f']); git('add', '.'); git('commit', '-qm', 'init');
write('f.txt', ['a', 'b', 'C2', 'd', 'e', 'f']); git('commit', '-qam', 'change c');
write('f.txt', ['x', 'y', 'a', 'b', 'C2', 'd', 'e', 'f']); git('commit', '-qam', 'prepend lines (moves range)');
write('f.txt', ['x', 'y', 'a', 'b', 'C2', 'D3', 'e', 'f']); git('commit', '-qam', 'change d');
write('f.txt', ['x', 'y', 'a', 'b', 'C2', 'D3', 'e', 'f', 'zzz']); git('commit', '-qam', 'unrelated append');
git('mv', 'f.txt', 'g.txt'); git('commit', '-qm', 'rename');

// ---- vscode stub ----------------------------------------------------------------------
const VSC = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const userExt = path.join(os.homedir(), '.vscode', 'extensions');
const extDirs = fs.existsSync(VSC)
  ? ['theme-defaults', 'typescript-basics', 'javascript'].map(d => path.join(VSC, d))
      .concat(fs.existsSync(userExt) ? fs.readdirSync(userExt).filter(d => /monokai/i.test(d)).map(d => path.join(userExt, d)) : [])
  : [];
const THEME = process.env.TEST_THEME || 'Dark Modern';
const vscodeStub = {
  extensions: { all: extDirs.filter(p => fs.existsSync(path.join(p, 'package.json'))).map(p => ({ extensionPath: p, packageJSON: JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')) })) },
  workspace: { getConfiguration: () => ({ get: () => THEME }) },
};
const Module = require('module'); const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : origLoad.call(this, req, ...rest); };
const ext = require(OUT);

const LOG_FORMAT = '--format=%x1e%H%x00%h%x00%an%x00%ar%x00%as%x00%P%x00%s%x00%b%x1f';
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok', name); };

(async () => {
  await test('parseLog follows the range across moves and renames', () => {
    const entries = ext.parseLog(git('log', '--no-color', LOG_FORMAT, '-L', '5,6:g.txt'), 'g.txt');
    assert.deepStrictEqual(entries.map(e => e.subject), ['change d', 'change c', 'init']);
    assert.deepStrictEqual([entries[0].hunks[0].newStart, entries[0].hunks[0].newLen], [5, 2]);
    assert.deepStrictEqual(entries[0].hunks[0].lines, [{ kind: 'ctx', text: 'C2' }, { kind: 'del', text: 'd' }, { kind: 'add', text: 'D3' }]);
    assert.strictEqual(entries[0].hunks[0].context, 'y');
    assert.strictEqual(entries[0].right.path, 'f.txt', 'path at that revision is pre-rename');
    assert.strictEqual(entries[2].left, undefined, 'root commit has no left side');
  });

  await test('working tree -> index -> HEAD mapping with unstaged, staged and inserted lines', () => {
    write('g.txt', ['x', 'y', 'a', 'b', 'C2', 'D4', 'e', 'f', 'zzz']); git('add', 'g.txt');
    write('g.txt', ['NEW', 'x', 'y', 'a', 'b', 'C3', 'D4', 'e', 'f', 'zzz']);
    const unstaged = ext.parsePatch(git('diff', '-U0', '--', 'g.txt'), 'g.txt').hunks;
    const staged = ext.parsePatch(git('diff', '-U0', '--cached', '--', 'g.txt'), 'g.txt').hunks;
    const wt = { start: 6, end: 7 };
    const idx = ext.mapRangeThrough(wt, unstaged);
    assert.deepStrictEqual(idx, { start: 5, end: 6 }, 'modified line maps to the line it replaced');
    assert.deepStrictEqual(ext.mapRangeThrough(idx, staged), { start: 5, end: 6 });
    assert.strictEqual(ext.mapLineThrough(1, unstaged), null, 'inserted line has no counterpart');
    assert.ok(unstaged.some(h => ext.intersects(h, wt)));
    assert.ok(!unstaged.filter(h => h.newStart === 1).some(h => ext.intersects(h, wt)));
    assert.ok(staged.some(h => ext.intersects(h, idx)));
    git('reset', '-q', 'g.txt'); git('checkout', 'g.txt');
  });

  await test('windowHunk covers the whole selection with changes marked inside', () => {
    const oldL = ['a', 'b', 'c', 'd', 'e', 'f'], newL = ['NEW', 'a', 'b', 'C3', 'd', 'f'];
    const hunks = [
      { oldStart: 0, oldLen: 0, newStart: 1, newLen: 1 },
      { oldStart: 3, oldLen: 1, newStart: 4, newLen: 1 },
      { oldStart: 5, oldLen: 1, newStart: 5, newLen: 0 },
    ];
    const show = h => h.lines.map(l => (l.kind === 'ctx' ? ' ' : l.kind === 'add' ? '+' : '-') + l.text).join('|');
    let h = ext.windowHunk({ start: 3, end: 6 }, hunks, oldL, newL);
    assert.strictEqual(show(h), ' b|-c|+C3| d|-e| f');
    assert.deepStrictEqual([h.oldStart, h.oldLen, h.newStart, h.newLen], [2, 5, 3, 4]);
    h = ext.windowHunk({ start: 1, end: 2 }, hunks, oldL, newL);
    assert.strictEqual(show(h), '+NEW| a');
    h = ext.windowHunk({ start: 2, end: 3 }, hunks, oldL, newL);
    assert.strictEqual(show(h), ' a| b');
    h = ext.windowHunk({ start: 5, end: 6 }, hunks, oldL, newL);
    assert.strictEqual(show(h), ' d|-e| f');
    h = ext.windowHunk({ start: 4, end: 5 }, hunks, oldL, newL);
    assert.strictEqual(show(h), '-c|+C3| d|-e', 'a deletion right after the selection is shown');
    assert.deepStrictEqual(ext.sideRanges(hunks, 'old'), [{ start: 3, end: 3 }, { start: 5, end: 5 }]);
  });

  await test('webview renders the table and pairs removed/added lines', async () => {
    const entries = ext.parseLog(git('log', '--no-color', LOG_FORMAT, '-L', '5,6:g.txt'), 'g.txt');
    class El { constructor() { this.innerHTML = ''; this.style = { setProperty() {} }; }
      querySelector(sel) { return stubFor(sel); } querySelectorAll() { return []; }
      addEventListener() {} focus() { focused = true; } setAttribute() {} scrollIntoView() {} }
    const named = {}; const stubFor = sel => (named[sel] ||= new El());
    let focused = false; const posted = []; let listener;
    global.document = { getElementById: () => stubFor('#app'), documentElement: new El() };
    global.window = { addEventListener: (t, fn) => { listener = fn; } };
    global.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m), getState: () => ({}), setState() {} });
    new Function(fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8'))();
    assert.deepStrictEqual(posted[0], { type: 'ready' });
    listener({ data: { type: 'state', state: { title: 'g.txt L5-6', status: 'ready', entries } } });
    listener({ data: { type: 'focus' } });
    const diff = stubFor('.diff').innerHTML;
    assert.ok(stubFor('#app').innerHTML.includes('change d'));
    assert.ok(diff.includes('class="code del">d<') && diff.includes('class="code add">D3<'));
    assert.ok(!posted.some(m => m.type === 'tokens'), 'token request is debounced');
    await new Promise(r => setTimeout(r, 80));
    assert.ok(posted.some(m => m.type === 'tokens' && m.id === entries[0].id), 'token request sent after the debounce');
    assert.ok(focused);
    listener({ data: { type: 'tokens', id: entries[0].id, left: {}, right: { 6: [['D3', '#ff0000', 2]] } } });
    assert.ok(stubFor('.diff').innerHTML.includes('color:#ff0000;font-weight:bold;'), 'tokens applied');
  });

  if (vscodeStub.extensions.all.length) {
    const hl = new ext.Highlighter(path.join(__dirname, '..', 'out', 'onig.wasm'));
    const lines = ['// comment', 'const x: number = 1;', 'function f(a: string) { return `hi ${a}`; }'];
    const spans = await hl.tokenize('typescript', lines, lines.length);
    await test(`highlighter uses the installed grammar and theme (${THEME})`, () => {
      assert.ok(spans && spans.length === 3);
      for (let i = 0; i < 3; i++) { assert.strictEqual(spans[i].map(s => s[0]).join(''), lines[i]); }
      const colors = new Set(spans.flat().map(s => s[1]).filter(Boolean));
      assert.ok(colors.size >= 3, 'several theme colours applied');
    });
    await test('highlighter returns null without a grammar', async () => { assert.strictEqual(await hl.tokenize('plaintext', lines, 1), null); });
  } else {
    console.log('  skip highlighter tests (VS Code not installed at /Applications)');
  }

  fs.rmSync(repo, { recursive: true, force: true });
  console.log(`\n${passed} tests passed`);
})().catch(err => { console.error(err); fs.rmSync(repo, { recursive: true, force: true }); process.exit(1); });
