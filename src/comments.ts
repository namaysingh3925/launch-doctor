/**
 * Replace comments with spaces, keeping every newline (and every other character position)
 * so match indexes and line numbers stay the same as in the original text.
 *
 * Strings, template literals and URLs are left alone, so the "//" in "https://..." or in
 * `a // b` inside quotes is not treated as a comment.
 */
export function stripComments(text: string, path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'py' || ext === 'rb') return stripHashComments(text);
  if (ext === 'html' || ext === 'htm') return stripHtmlComments(text);
  if (ext === 'sql') return stripSqlComments(text);
  if (['vue', 'svelte', 'astro'].includes(ext)) return stripCLike(stripHtmlComments(text));
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'php', 'go'].includes(ext)) return stripCLike(text);
  return text;
}

/** Blank out text[from, to) but keep newlines. */
function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

/** JavaScript / TypeScript / PHP / Go: // and /* *\/ comments, skipping strings and template literals. */
function stripCLike(text: string): string {
  // split('') works on UTF-16 units, so positions match the original string exactly.
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i, c);
      continue;
    }
    if (c === '/' && next === '/') {
      // "https://" and similar: a colon right before means a URL, not a comment.
      if (i > 0 && text[i - 1] === ':') {
        i += 2;
        continue;
      }
      let end = text.indexOf('\n', i);
      if (end === -1) end = n;
      blank(out, i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
      blank(out, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just after the closing quote of a string that starts at `start`. */
function skipString(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    // Plain strings end at a newline (unterminated); template literals can span lines.
    if (c === '\n' && quote !== '`') return i;
    i++;
  }
  return i;
}

function stripHtmlComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while ((i = text.indexOf('<!--', i)) !== -1) {
    let end = text.indexOf('-->', i + 4);
    end = end === -1 ? text.length : end + 3;
    blank(out, i, end);
    i = end;
  }
  return out.join('');
}

/** Python / Ruby: # comments, skipping quoted strings. */
function stripHashComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i, c);
      continue;
    }
    if (c === '#') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      blank(out, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

function stripSqlComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'") {
      i = skipString(text, i, c);
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      blank(out, i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? text.length : end + 2;
      blank(out, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}
