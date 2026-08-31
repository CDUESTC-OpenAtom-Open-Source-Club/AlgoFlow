export interface ReviewIssue { line: number; severity: 'error' | 'warning' | 'info'; message: string; }

export function reviewCpp(source: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const lines = source.split('\n');
  if (!/\bmain\s*\(/.test(source)) issues.push({ line: 1, severity: 'warning', message: '未发现 main() 入口函数' });
  if (!/^\s*#\s*include\b/m.test(source)) issues.push({ line: 1, severity: 'info', message: '当前文件没有 #include，确认是否需要引入头文件' });
  const seenIncludes = new Set<string>();
  lines.forEach((line, index) => { const match = line.match(/^\s*#\s*include\s*([<\"].*[>\"])/); const header = match?.[1]; if (header) { if (seenIncludes.has(header)) issues.push({ line: index + 1, severity: 'warning', message: `重复引入头文件 ${header}` }); seenIncludes.add(header); } });
  if (/\busing\s+namespace\s+std\s*;/.test(source)) issues.push({ line: lines.findIndex((line) => /\busing\s+namespace\s+std\s*;/.test(line)) + 1, severity: 'info', message: '大型项目中建议避免 using namespace std' });
  if (/\b(void|int|bool|double|float)\s+\w+\s*\(\s*\)\s*\{\s*\}/.test(source)) issues.push({ line: lines.findIndex((line) => /\b(void|int|bool|double|float)\s+\w+\s*\(\s*\)\s*\{\s*\}/.test(line)) + 1, severity: 'warning', message: '发现空函数' });
  const stack: Array<{ char: string; line: number }> = [];
  let inBlockComment = false;
  lines.forEach((line, lineIndex) => {
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      const pair = line.slice(i, i + 2);
      if (!inString && !inBlockComment && pair === '//') break;
      if (!inString && pair === '/*') { inBlockComment = true; i += 1; continue; }
      if (inBlockComment) { if (pair === '*/') { inBlockComment = false; i += 1; } continue; }
      if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if ('({['.includes(line[i] ?? '')) stack.push({ char: line[i] ?? '', line: lineIndex + 1 });
      if (')}]'.includes(line[i] ?? '')) {
        const expected = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[line[i] ?? ''];
        const top = stack.pop();
        if (!top || top.char !== expected) issues.push({ line: lineIndex + 1, severity: 'error', message: `括号不匹配：${line[i]}` });
      }
    }
  });
  stack.forEach((item) => issues.push({ line: item.line, severity: 'error', message: `未闭合括号：${item.char}` }));
  if (inBlockComment) issues.push({ line: lines.length, severity: 'warning', message: '块注释未闭合' });
  return issues.sort((a, b) => a.line - b.line);
}
