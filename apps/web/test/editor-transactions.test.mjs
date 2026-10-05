import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { completionTransaction, editorText, externalDocumentTransaction, lineSeparator, separatorExtension } from '../src/editor-transactions.mjs';

for (const newline of ['\n', '\r\n']) {
  test(`multiline completion preserves ${JSON.stringify(newline)}, cursor and one undo`, () => {
    const source = ['// before', 'count++;', '// after'].join(newline);
    let state = EditorState.create({ doc: editorText(source), extensions: [history(), lineSeparator.of(separatorExtension(source))] });
    state = completionTransaction(state, { id: 'test', sourceCode: source,
      range: { start_line: 2, start_char: 0, end_line: 2, end_char: 8 }, insert: 'count += 2;\ncount += 3;' }).state;
    assert.equal(state.sliceDoc(), ['// before', 'count += 2;', 'count += 3;', '// after'].join(newline));
    assert.equal(state.doc.lineAt(state.selection.main.head).number, 3);
    assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
    assert.equal(state.sliceDoc(), source);
  });
}

test('external LF/CRLF changes reconfigure serialization before subsequent acceptance', () => {
  let state = EditorState.create({ doc: 'a\nb', extensions: [history(), lineSeparator.of(separatorExtension('a\nb'))] });
  for (const source of ['a\r\nb', 'a\nb']) {
    state = externalDocumentTransaction(state, source).state;
    assert.equal(state.sliceDoc(), source);
    state = completionTransaction(state, { id: 'test', sourceCode: source,
      range: { start_line: 2, start_char: 0, end_line: 2, end_char: 1 }, insert: 'c\r\nd' }).state;
    assert.equal(state.doc.lines, 3);
    assert.equal(state.sliceDoc(), source.includes('\r') ? 'a\r\nc\r\nd' : 'a\nc\nd');
  }
});
