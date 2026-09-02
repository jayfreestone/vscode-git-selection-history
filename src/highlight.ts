import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Registry, INITIAL, IGrammar, IRawTheme, StateStack, parseRawGrammar } from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
import { parse as parseJsonc } from 'jsonc-parser';

/** [text, css color or undefined, font style bits: 1 italic, 2 bold, 4 underline, 8 strikethrough] */
export type Span = [string, string | undefined, number];

const FONT_STYLE_MASK = 0b00000000000000000111100000000000;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0b00000000111111111000000000000000;
const FOREGROUND_OFFSET = 15;

interface ThemeJson { tokenColors: unknown[]; colors: Record<string, string>; }

/**
 * Tokenizes text with the same TextMate grammars and colour theme the editor is using,
 * so the panel's highlighting matches the user's editor exactly.
 */
export class Highlighter {
  private static wasmLoaded = false;
  private ready?: Promise<void>;
  private registry?: Registry;
  private colorMap: string[] = [];
  private scopeToPath = new Map<string, string>();
  private langToScope = new Map<string, string>();
  private injections = new Map<string, string[]>();
  private grammars = new Map<string, Promise<IGrammar | null>>();

  constructor(private readonly wasmPath: string) {}

  /** Forget the theme and grammars (call when the colour theme changes). */
  reset() {
    this.ready = undefined;
    this.registry = undefined;
    this.grammars.clear();
  }

  private init(): Promise<void> {
    if (!this.ready) { this.ready = this.doInit(); }
    return this.ready;
  }

  private async doInit() {
    if (!Highlighter.wasmLoaded) {
      const buf = fs.readFileSync(this.wasmPath);
      await loadWASM(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      Highlighter.wasmLoaded = true;
    }
    this.scopeToPath.clear(); this.langToScope.clear(); this.injections.clear();
    for (const ext of vscode.extensions.all) {
      const grammars: any[] = ext.packageJSON?.contributes?.grammars ?? [];
      for (const g of grammars) {
        if (!g.scopeName || !g.path) { continue; }
        const file = path.join(ext.extensionPath, g.path);
        if (!this.scopeToPath.has(g.scopeName)) { this.scopeToPath.set(g.scopeName, file); }
        if (g.language && !this.langToScope.has(g.language)) { this.langToScope.set(g.language, g.scopeName); }
        for (const target of g.injectTo ?? []) {
          const list = this.injections.get(target) ?? [];
          list.push(g.scopeName);
          this.injections.set(target, list);
        }
      }
    }
    this.registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      theme: loadActiveTheme(),
      loadGrammar: async scope => {
        const file = this.scopeToPath.get(scope);
        if (!file) { return null; }
        try { return parseRawGrammar(fs.readFileSync(file, 'utf8'), file); } catch { return null; }
      },
      getInjections: scope => this.injections.get(scope),
    });
    this.colorMap = this.registry.getColorMap();
  }

  /** Tokenize the first `upTo` lines. Returns null when no grammar exists or the time budget is exceeded. */
  async tokenize(languageId: string, lines: string[], upTo: number, budgetMs = 2500): Promise<Span[][] | null> {
    await this.init();
    const scope = this.langToScope.get(languageId);
    if (!scope || !this.registry) { return null; }
    let pending = this.grammars.get(scope);
    if (!pending) {
      pending = this.registry.loadGrammar(scope).catch(() => null);
      this.grammars.set(scope, pending);
    }
    const grammar = await pending;
    if (!grammar) { return null; }

    const out: Span[][] = [];
    let stack: StateStack = INITIAL;
    const deadline = Date.now() + budgetMs;
    const n = Math.min(upTo, lines.length);
    for (let i = 0; i < n; i++) {
      if ((i & 63) === 0 && Date.now() > deadline) { return null; }
      const line = lines[i];
      const result = grammar.tokenizeLine2(line, stack);
      const t = result.tokens;
      const spans: Span[] = [];
      for (let j = 0; j < t.length; j += 2) {
        const start = t[j];
        const end = j + 2 < t.length ? t[j + 2] : line.length;
        const meta = t[j + 1];
        const color = this.colorMap[(meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET];
        const style = (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
        const text = line.slice(start, end);
        const last = spans[spans.length - 1];
        if (last && last[1] === color && last[2] === style) { last[0] += text; } else { spans.push([text, color, style]); }
      }
      out.push(spans);
      stack = result.ruleStack;
    }
    return out;
  }
}

/** Find the active colour theme among installed extensions and convert it to a TextMate theme. */
export function loadActiveTheme(): IRawTheme | undefined {
  const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!name) { return undefined; }
  for (const ext of vscode.extensions.all) {
    const themes: any[] = ext.packageJSON?.contributes?.themes ?? [];
    for (const t of themes) {
      const label = resolveNls(ext.extensionPath, t.label);
      if (t.id !== name && label !== name) { continue; }
      const file = path.join(ext.extensionPath, t.path);
      if (!file.toLowerCase().endsWith('.json')) { return undefined; } // legacy .tmTheme themes are not supported
      const merged = readThemeJson(file, new Set());
      if (!merged) { return undefined; }
      return {
        name,
        settings: [
          { settings: { foreground: merged.colors['editor.foreground'], background: merged.colors['editor.background'] } },
          ...(merged.tokenColors as any[]),
        ],
      };
    }
  }
  return undefined;
}

const nlsCache = new Map<string, Record<string, string> | null>();
function resolveNls(extensionPath: string, label: unknown): string {
  if (typeof label !== 'string') { return ''; }
  const m = /^%(.+)%$/.exec(label);
  if (!m) { return label; }
  let nls = nlsCache.get(extensionPath);
  if (nls === undefined) {
    try { nls = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.nls.json'), 'utf8')); } catch { nls = null; }
    nlsCache.set(extensionPath, nls ?? null);
  }
  return nls?.[m[1]] ?? label;
}

function readThemeJson(file: string, seen: Set<string>): ThemeJson | undefined {
  if (seen.has(file)) { return undefined; }
  seen.add(file);
  let json: any;
  try { json = parseJsonc(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
  if (!json || typeof json !== 'object') { return undefined; }
  let tokenColors: unknown[] = [];
  let colors: Record<string, string> = {};
  if (typeof json.include === 'string') {
    const inc = readThemeJson(path.resolve(path.dirname(file), json.include), seen);
    if (inc) { tokenColors = inc.tokenColors; colors = inc.colors; }
  }
  if (Array.isArray(json.tokenColors)) { tokenColors = tokenColors.concat(json.tokenColors); }
  if (json.colors && typeof json.colors === 'object') { colors = { ...colors, ...json.colors }; }
  return { tokenColors, colors };
}
