import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
  type UIEvent,
} from 'react';

interface CodeEditorProps {
  activeFile: string;
  value: string;
  onChange: (value: string) => void;
}

export function CodeEditor({ activeFile, value, onChange }: CodeEditorProps) {
  const [activeLine, setActiveLine] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const lines = useMemo(() => value.split('\n'), [value]);

  useEffect(() => {
    setActiveLine(0);
    setScrollTop(0);
  }, [activeFile]);

  function updateActiveLine(event: SyntheticEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    const cursor = textarea.selectionStart ?? 0;
    setActiveLine(textarea.value.slice(0, cursor).split('\n').length - 1);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value);
    updateActiveLine(event);
  }

  function handleScroll(event: UIEvent<HTMLTextAreaElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return (
    <div className="code-editor">
      <div
        className="line-numbers"
        aria-hidden="true"
        style={{ transform: `translateY(-${scrollTop}px)` }}
      >
        {lines.map((_, index) => (
          <span key={index}>{String(index + 1).padStart(2, '0')}</span>
        ))}
      </div>
      <div
        className="line-highlight"
        aria-hidden="true"
        style={{ top: `${21 + activeLine * 22 - scrollTop}px` }}
      />
      <textarea
        aria-label={`${activeFile} 文档编辑器`}
        spellCheck={activeFile !== 'main.cpp'}
        value={value}
        onChange={handleChange}
        onClick={updateActiveLine}
        onKeyUp={updateActiveLine}
        onSelect={updateActiveLine}
        onScroll={handleScroll}
      />
    </div>
  );
}
