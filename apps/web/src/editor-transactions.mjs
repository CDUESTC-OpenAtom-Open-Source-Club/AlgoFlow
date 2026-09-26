import { Compartment, EditorState, Text, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { rangeToOffsets } from './ai-client.mjs';

export const lineSeparator = new Compartment();
/** @param {string} value */
export function editorText(value) { return Text.of(value.split(/\r\n|\n|\r/)); }
/** @param {string} value */
export function separatorExtension(value) {
  return EditorState.lineSeparator.of(value.includes('\r\n') ? '\r\n' : '\n');
}
/** @param {EditorState} state @param {import('./types').AIEditorChange} change */
export function completionTransaction(state, change) {
  if (state.sliceDoc() !== change.sourceCode) throw new Error('Source changed');
  const { from, to } = rangeToOffsets(state.doc.toString(), change.range);
  const insert = editorText(change.insert);
  return state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length },
    annotations: [Transaction.userEvent.of('input.ai-completion'), isolateHistory.of('full')] });
}
/** @param {EditorState} state @param {string} value */
export function externalDocumentTransaction(state, value) {
  return state.update({ changes: { from: 0, to: state.doc.length, insert: editorText(value) },
    effects: lineSeparator.reconfigure(separatorExtension(value)),
    annotations: [Transaction.addToHistory.of(false), isolateHistory.of('full')] });
}
