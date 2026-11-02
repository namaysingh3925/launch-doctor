/** 1-based line number of a character index. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** The full text of the line containing `index`. */
export function lineTextAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/** Show only the start and end of a secret, never the whole thing. */
export function mask(secret: string): string {
  if (secret.length <= 12) return `${secret.slice(0, 4)}…`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

/** True for obvious fake values like a key made of "xxxx…" or "your-key-here". */
export function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    /x{4,}|\*{3,}|0{6,}|123456|abcdef|your|example|placeholder|dummy|sample|redacted|changeme|replace|insert|<|>|\$\{/.test(
      lower,
    )
  ) {
    return true;
  }
  const tail = value.slice(-16);
  return new Set(tail).size < 6;
}

/** Decode the middle part of a JWT. Returns null if it isn't one. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function mostCommon<T>(items: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
