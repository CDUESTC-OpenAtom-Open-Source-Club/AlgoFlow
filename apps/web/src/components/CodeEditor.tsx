import { useEffect, useRef } from 'react';
import { cpp } from '@codemirror/lang-cpp';
import { acceptCompletion, autocompletion, closeBrackets, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, hoverTooltip, type Tooltip } from '@codemirror/view';
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { reviewCpp } from '../code-review';

interface CodeEditorProps {
  activeFile: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  jumpToLine?: number;
  onCursorChange?: (line: number, column: number) => void;
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: '#f0eff7', backgroundColor: '#252735' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", monospace', lineHeight: '22px' },
  '.cm-content': { padding: '21px 24px 20px 0', caretColor: '#e6ebe3' },
  '.cm-gutters': { backgroundColor: '#252735', color: '#737896', border: '0', paddingRight: '11px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'rgba(155, 188, 162, .08)' },
  '.cm-activeLineGutter': { color: '#d8ebd7', backgroundColor: 'rgba(155, 188, 162, .08)' },
  '.cm-matchingBracket': { color: '#ffe082', backgroundColor: 'rgba(255, 224, 130, .2)', outline: '1px solid rgba(255, 224, 130, .6)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#f0eff7' },
}, { dark: true });

const syntaxColors = HighlightStyle.define([
  { tag: tags.comment, color: '#6a9955' },
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: '#c586c0' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#4ec9b0' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#dcdcaa' },
  { tag: tags.variableName, color: '#9cdcfe' },
  { tag: [tags.string, tags.special(tags.string)], color: '#ce9178' },
  { tag: tags.number, color: '#b5cea8' },
  { tag: [tags.operator, tags.punctuation], color: '#d4d4d4' },
  { tag: tags.bool, color: '#569cd6' },
  { tag: tags.meta, color: '#c586c0' },
]);

export function CodeEditor({ activeFile, value, onChange, onSave, jumpToLine, onCursorChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({ doc: value, extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), highlightSelectionMatches(), rectangularSelection(), drawSelection(), history(),
      foldGutter(), bracketMatching(), closeBrackets(), indentOnInput(), indentUnit.of('  '), ...(activeFile.endsWith('.cpp') ? [cpp(), syntaxHighlighting(syntaxColors)] : []), editorTheme,
      ...(activeFile.endsWith('.cpp') ? [lintGutter(), linter((editor) => buildDiagnostics(editor.state.doc.toString()), { delay: 350 })] : []),
      autocompletion({ override: [cppCompletions], defaultKeymap: false }),
      hoverTooltip(cppHoverTooltip),
      keymap.of([
        { key: 'Mod-s', run: () => { saveRef.current?.(); return true; } },
        { key: 'Mod-Shift-d', run: duplicateLine }, { key: 'Mod-Shift-k', run: deleteLine },
        { key: 'Alt-ArrowUp', run: (view) => moveLine(view, -1) }, { key: 'Alt-ArrowDown', run: (view) => moveLine(view, 1) },
        { key: 'Mod-Alt-ArrowUp', run: (view) => addLineCursor(view, -1) }, { key: 'Mod-Alt-ArrowDown', run: (view) => addLineCursor(view, 1) },
        { key: 'Mod-l', run: goToLine }, { key: 'Mod-Shift-f', run: formatDocument },
        { key: 'Tab', run: acceptCompletion }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          const position = update.state.selection.main.head;
          const line = update.state.doc.lineAt(position);
          onCursorChange?.(line.number, position - line.from + 1);
        }
      }),
    ] });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    const initialLine = state.doc.lineAt(state.selection.main.head);
    onCursorChange?.(initialLine.number, state.selection.main.head - initialLine.from + 1);
    return () => { view.destroy(); viewRef.current = null; };
    // The editor is recreated only when switching files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, onCursorChange]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    const position = view.state.selection.main.head;
    const line = view.state.doc.lineAt(position);
    onCursorChange?.(line.number, position - line.from + 1);
  }, [value, onCursorChange]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jumpToLine || jumpToLine < 1) return;
    const line = view.state.doc.line(Math.min(jumpToLine, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  }, [jumpToLine]);

  return <div ref={hostRef} className="code-editor" aria-label={`${activeFile} 文档编辑器`} />;
}

function duplicateLine(view: EditorView): boolean {
  const changes = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.from);
    return { changes: { from: line.from, to: line.to, insert: `${line.text}\n${line.text}` }, range: EditorSelection.cursor(range.from + line.text.length + 1) };
  });
  view.dispatch(changes); return true;
}

function deleteLine(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const from = line.from; const to = line.to < view.state.doc.length ? line.to + 1 : Math.max(line.from, line.from - 1);
  view.dispatch({ changes: { from, to }, selection: { anchor: Math.min(from, view.state.doc.length - 1) } }); return true;
}

function moveLine(view: EditorView, direction: -1 | 1): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const targetNumber = line.number + direction;
  if (targetNumber < 1 || targetNumber > view.state.doc.lines) return true;
  const target = view.state.doc.line(targetNumber);
  const text = line.text;
  const from = direction < 0 ? target.from : line.from;
  const to = direction < 0 ? line.to + 1 : target.to + 1;
  const insert = direction < 0 ? `${text}\n${target.text}` : `${target.text}\n${text}`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: direction < 0 ? target.from : target.from } }); return true;
}

function addLineCursor(view: EditorView, direction: -1 | 1): boolean {
  const main = view.state.selection.main;
  const line = view.state.doc.lineAt(main.from);
  const target = line.number + direction;
  if (target < 1 || target > view.state.doc.lines) return true;
  const targetLine = view.state.doc.line(target);
  const anchor = Math.min(targetLine.from + (main.from - line.from), targetLine.to);
  view.dispatch({ selection: EditorSelection.create([...view.state.selection.ranges, EditorSelection.cursor(anchor)]) });
  return true;
}

function goToLine(view: EditorView): boolean {
  const input = window.prompt('跳转到行号');
  const number = Number(input);
  if (Number.isInteger(number) && number > 0 && number <= view.state.doc.lines) {
    const line = view.state.doc.line(number);
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }
  return true;
}

function formatDocument(view: EditorView): boolean {
  const lines = view.state.doc.toString().split('\n'); let level = 0;
  const formatted = lines.map((line) => { const trimmed = line.trim(); if (!trimmed) return ''; if (trimmed.startsWith('}')) level = Math.max(0, level - 1); const result = `${'  '.repeat(level)}${trimmed}`; if (trimmed.endsWith('{')) level += 1; return result; }).join('\n');
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } }); return true;
}

function cppHoverTooltip(view: EditorView, pos: number): Tooltip | null {
  const word = view.state.wordAt(pos); if (!word) return null;
  const docs: Record<string, string> = { vector: '动态数组：std::vector<T>', map: '有序键值容器：std::map<K, V>', sort: '排序算法：std::sort(first, last)', pair: '二元组：std::pair<T1, T2>', unordered_map: '哈希键值容器' };
  const token = view.state.sliceDoc(word.from, word.to);
  const text = docs[token]; if (!text) return null;
  return { pos: word.from, end: word.to, above: true, create: () => ({ dom: Object.assign(document.createElement('div'), { className: 'cm-tooltip-cpp', textContent: text }) }) };
}

function buildDiagnostics(source: string): Diagnostic[] {
  return reviewCpp(source).map((issue) => {
    const lines = source.split('\n');
    const lineStart = lines.slice(0, Math.max(0, issue.line - 1)).reduce((total, line) => total + line.length + 1, 0);
    return { from: lineStart, to: Math.min(source.length, lineStart + Math.max(1, lines[issue.line - 1]?.length ?? 1)), severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info', message: issue.message, source: 'AlgoFlow' };
  });
}

const cppWords = [
  'alignas', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'delete', 'double', 'else', 'false', 'for', 'if', 'include', 'int', 'long',
  'namespace', 'nullptr', 'return', 'short', 'sizeof', 'static', 'std', 'struct', 'switch',
  'template', 'this', 'throw', 'true', 'try', 'using', 'void', 'while',
];
const cppTypes = ['string', 'vector', 'array', 'map', 'unordered_map', 'set', 'unordered_set', 'pair', 'queue', 'stack', 'deque', 'tuple'];
const cppSnippets = [
  { label: 'for-loop', apply: 'for (int i = 0; i < n; ++i) {\n  \n}', detail: '循环模板' },
  { label: 'range-for', apply: 'for (const auto& item : items) {\n  \n}', detail: '范围循环' },
  { label: 'if-else', apply: 'if (condition) {\n  \n} else {\n  \n}', detail: '条件模板' },
  { label: 'main', apply: 'int main() {\n  return 0;\n}', detail: '程序入口' },
];

function cppCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;
  const from = word?.from ?? context.pos;
  return { from, options: [
    ...cppWords.map((label) => ({ label, type: 'keyword' })),
    ...cppTypes.map((label) => ({ label, type: 'type' })),
    ...cppSnippets.map((snippet) => ({ ...snippet, type: 'snippet' })),
  ], validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
}
