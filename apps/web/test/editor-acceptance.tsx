import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeEditor } from '../src/components/CodeEditor';
import type { ApplyAIEditorChange } from '../src/types';

function Harness() {
  const [value, setValue] = useState('// before\r\ncount++;\r\n// after');
  const [position, setPosition] = useState('1:1');
  const apply = useRef<ApplyAIEditorChange | null>(null);
  const ready = useCallback((next: ApplyAIEditorChange | null) => { apply.current = next; }, []);
  const cursor = useCallback((line: number, column: number) => setPosition(`${line}:${column}`), []);
  return <main><h1>编辑器验收（测试数据）</h1>
    <button onClick={() => setValue('// before\ncount++;\n// after')}>外部 LF 更新</button>
    <button onClick={() => setValue('// before\r\ncount++;\r\n// after')}>外部 CRLF 更新</button>
    <button onClick={() => apply.current?.({ id: 'fixture', sourceCode: value,
      range: { start_line: 2, start_char: 0, end_line: 2, end_char: 8 }, insert: 'count += 2;\ncount += 3;' })}>接受多行片段</button>
    <div style={{ height: 250 }}><CodeEditor activeFile="main.cpp" value={value} onChange={setValue} onEditorReady={ready} onCursorChange={cursor} /></div>
    <p aria-label="光标">{position}</p><pre aria-label="序列化文本">{JSON.stringify(value)}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
