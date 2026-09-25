// A bounded lexical gate for completion text, not a C++ parser or macro expander.
// No runtime dependencies: the gateway and future Web clients can use the same gate.
export function validateCompletionFragment(source) {
  if (typeof source !== 'string') return ['suggestion_text must be a string'];
  const { text, offsets } = spliceLines(source);
  const errors = new Set();
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text.startsWith('//', index)) {
      const end = text.slice(index + 2).search(/[\r\n]/);
      index = end < 0 ? text.length : index + 2 + end;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) {
        errors.add('suggestion_text contains an unterminated block comment');
        break;
      }
      index = end + 2;
      continue;
    }

    const rawPrefix = /^(?:u8|u|U|L)?R"/.exec(text.slice(index));
    if (rawPrefix) {
      // Raw literal contents undo line splicing in C++. Locate their terminator
      // in the original source, not a spliced copy that could invent a terminator.
      const quote = offsets[index + rawPrefix[0].length - 1];
      const delimiter = /^([^ ()\\\t\v\f\r\n]{0,16})\(/.exec(source.slice(quote + 1));
      if (!delimiter) {
        errors.add('suggestion_text contains an invalid raw string delimiter');
        break;
      }
      const terminator = `)${delimiter[1]}"`;
      const end = source.indexOf(terminator, quote + 1 + delimiter[0].length);
      if (end < 0) {
        errors.add('suggestion_text contains an unterminated raw string');
        break;
      }
      while (index < text.length && offsets[index] < end + terminator.length) index++;
      continue;
    }

    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      let closed = false;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index++] === quote) { closed = true; break; }
      }
      if (!closed) {
        errors.add('suggestion_text contains an unterminated quoted literal');
        break;
      }
      continue;
    }

    // Consume preprocessing-number tokens so 1'000 is not a character literal.
    if (/[0-9]/.test(text[index]) || (text[index] === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      index++;
      while (index < text.length) {
        if (/[a-zA-Z0-9_.]/.test(text[index])) { index++; continue; }
        if (text[index] === "'" && /[a-zA-Z0-9_]/.test(text[index + 1] ?? '')) { index += 2; continue; }
        if (/[+-]/.test(text[index]) && /[eEpP]/.test(text[index - 1])) { index++; continue; }
        break;
      }
      continue;
    }

    const identifier = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(text.slice(index));
    if (identifier) {
      // Reject the standalone token, including parenthesized declarations/calls.
      // This intentionally excludes every use of main as an identifier.
      if (identifier[0] === 'main') errors.add('suggestion_text must not contain the main identifier');
      index += identifier[0].length;
      continue;
    }
    if (text[index] === '#' || text.startsWith('%:', index) || text.startsWith('??=', index)) {
      errors.add('suggestion_text must not contain preprocessor tokens');
    }
    // Universal-character escapes and legacy trigraph spellings are outside the
    // supported code-token subset. Literal contents have already been skipped.
    if (text[index] === '\\' || text.startsWith('??/', index)) {
      errors.add('suggestion_text contains an unsupported escaped code token');
    }
    index++;
  }
  return [...errors];
}

function spliceLines(source) {
  let text = '';
  const offsets = [];
  for (let index = 0; index < source.length;) {
    if (source[index] === '\\') {
      const splice = /^\\[ \t\v\f]*(?:\r\n|\n|\r)/.exec(source.slice(index));
      if (splice) { index += splice[0].length; continue; }
    }
    offsets.push(index);
    text += source[index++];
  }
  return { text, offsets };
}
