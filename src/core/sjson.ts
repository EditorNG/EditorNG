/**
 * Tolerant SJSON parser for BeamNG .jbeam / .pc / .json files.
 *
 * BeamNG's own reader accepts a relaxed JSON dialect: `//` and block comments,
 * missing or trailing commas, and stray separators. This parser accepts the same
 * input and produces an AST where every value keeps its source offsets, so the
 * editor can apply surgical text edits (comments and formatting are never rewritten).
 */

export type ANode = AObj | AArr | AStr | ANum | ABool | ANull;

interface ABase {
  /** start offset (inclusive) */
  s: number;
  /** end offset (exclusive) */
  e: number;
}
export interface AObj extends ABase {
  k: 'obj';
  keys: AStr[];
  vals: ANode[];
}
export interface AArr extends ABase {
  k: 'arr';
  items: ANode[];
}
export interface AStr extends ABase {
  k: 'str';
  v: string;
}
export interface ANum extends ABase {
  k: 'num';
  v: number;
}
export interface ABool extends ABase {
  k: 'bool';
  v: boolean;
}
export interface ANull extends ABase {
  k: 'null';
}

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface ParseIssue {
  s: number;
  e: number;
  msg: string;
  sev: Severity;
  code?: string;
}

export interface ParseResult {
  root: ANode | null;
  issues: ParseIssue[];
}

const C_TAB = 9, C_LF = 10, C_CR = 13, C_SPACE = 32, C_QUOTE = 34, C_STAR = 42, C_PLUS = 43,
  C_COMMA = 44, C_MINUS = 45, C_DOT = 46, C_SLASH = 47, C_0 = 48, C_9 = 57, C_COLON = 58,
  C_EQ = 61, C_LBRACK = 91, C_BSLASH = 92, C_RBRACK = 93, C_LBRACE = 123, C_RBRACE = 125;

export function parseSjson(text: string): ParseResult {
  const issues: ParseIssue[] = [];
  const len = text.length;
  let i = 0;
  // BOM
  if (len > 0 && text.charCodeAt(0) === 0xfeff) i = 1;

  /** Skips whitespace and comments. Returns true if at least one newline was crossed. */
  function skipWs(): void {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === C_SPACE || c === C_TAB || c === C_LF || c === C_CR) {
        i++;
      } else if (c === C_SLASH) {
        const n = text.charCodeAt(i + 1);
        if (n === C_SLASH) {
          i += 2;
          while (i < len && text.charCodeAt(i) !== C_LF) i++;
        } else if (n === C_STAR) {
          const start = i;
          const end = text.indexOf('*/', i + 2);
          if (end < 0) {
            issues.push({ s: start, e: len, msg: 'Unterminated block comment (everything after it is ignored)', sev: 'warning', code: 'open-comment' });
            i = len;
          } else {
            i = end + 2;
          }
        } else {
          return;
        }
      } else {
        return;
      }
    }
  }

  /** Skips whitespace, comments and commas. Returns number of commas seen. */
  function skipSep(): number {
    let commas = 0;
    for (;;) {
      skipWs();
      if (text.charCodeAt(i) === C_COMMA) {
        commas++;
        i++;
      } else {
        return commas;
      }
    }
  }

  function parseString(): AStr {
    const s = i;
    i++; // opening quote
    let out = '';
    let chunk = i;
    for (;;) {
      if (i >= len) {
        issues.push({ s, e: len, msg: 'Unterminated string', sev: 'error' });
        out += text.slice(chunk, i);
        return { k: 'str', s, e: i, v: out };
      }
      const c = text.charCodeAt(i);
      if (c === C_QUOTE) {
        out += text.slice(chunk, i);
        i++;
        return { k: 'str', s, e: i, v: out };
      }
      if (c === C_LF) {
        // strings never span lines in jbeam; recover at end of line
        issues.push({ s, e: i, msg: 'Unterminated string (missing closing quote)', sev: 'error' });
        out += text.slice(chunk, i);
        return { k: 'str', s, e: i, v: out.replace(/\r$/, '') };
      }
      if (c === C_BSLASH) {
        out += text.slice(chunk, i);
        const n = text[i + 1];
        i += 2;
        switch (n) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'u': {
            const hex = text.slice(i, i + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              i += 4;
            } else {
              out += 'u';
            }
            break;
          }
          default: out += n ?? '';
        }
        chunk = i;
        continue;
      }
      i++;
    }
  }

  function isDelim(c: number): boolean {
    return (
      c === C_SPACE || c === C_TAB || c === C_LF || c === C_CR || c === C_COMMA || c === C_RBRACK ||
      c === C_RBRACE || c === C_LBRACK || c === C_LBRACE || c === C_COLON || c === C_QUOTE || c !== c
    );
  }

  function parseBare(): ANode {
    const s = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (isDelim(c)) break;
      if (c === C_SLASH) {
        const n = text.charCodeAt(i + 1);
        if (n === C_SLASH || n === C_STAR) break;
      }
      i++;
    }
    const word = text.slice(s, i);
    if (word === 'true') return { k: 'bool', s, e: i, v: true };
    if (word === 'false') return { k: 'bool', s, e: i, v: false };
    if (word === 'null') return { k: 'null', s, e: i };
    const num = Number(word);
    if (word.length > 0 && !Number.isNaN(num)) {
      return { k: 'num', s, e: i, v: num };
    }
    if (/^[+-]?(inf|infinity)$/i.test(word)) {
      return { k: 'num', s, e: i, v: word[0] === '-' ? -Infinity : Infinity };
    }
    if (i === s) {
      // unexpected single character, consume it to guarantee progress
      i++;
      issues.push({ s, e: i, msg: `Unexpected character '${text[s]}'`, sev: 'error' });
      return { k: 'null', s, e: i };
    }
    issues.push({ s, e: i, msg: `Unexpected token '${word}' (strings need double quotes)`, sev: 'error' });
    return { k: 'str', s, e: i, v: word };
  }

  function parseValue(): ANode {
    const c = text.charCodeAt(i);
    if (c === C_LBRACE) return parseObject();
    if (c === C_LBRACK) return parseArray();
    if (c === C_QUOTE) return parseString();
    return parseBare();
  }

  function parseArray(): AArr {
    const s = i;
    i++;
    const items: ANode[] = [];
    let prevEnd = -1;
    for (;;) {
      const before = i;
      const commas = skipSep();
      if (i >= len) {
        issues.push({ s, e: s + 1, msg: "Unclosed '[' ", sev: 'error' });
        return { k: 'arr', s, e: len, items };
      }
      const c = text.charCodeAt(i);
      if (c === C_RBRACK) {
        i++;
        return { k: 'arr', s, e: i, items };
      }
      if (c === C_RBRACE) {
        issues.push({ s: i, e: i + 1, msg: "Mismatched '}' — expected ']'", sev: 'error' });
        // do not consume: let the parent object close itself
        return { k: 'arr', s, e: i, items };
      }
      if (items.length > 0 && commas === 0) {
        issues.push({ s: prevEnd, e: prevEnd, msg: 'Missing comma', sev: 'hint', code: 'missing-comma' });
      } else if (commas > 1) {
        issues.push({ s: before, e: i, msg: 'Duplicate comma', sev: 'hint', code: 'extra-comma' });
      }
      const v = parseValue();
      items.push(v);
      prevEnd = v.e;
    }
  }

  function parseObject(): AObj {
    const s = i;
    i++;
    const keys: AStr[] = [];
    const vals: ANode[] = [];
    let prevEnd = -1;
    for (;;) {
      const before = i;
      const commas = skipSep();
      if (i >= len) {
        issues.push({ s, e: s + 1, msg: "Unclosed '{'", sev: 'error' });
        return { k: 'obj', s, e: len, keys, vals };
      }
      const c = text.charCodeAt(i);
      if (c === C_RBRACE) {
        i++;
        return { k: 'obj', s, e: i, keys, vals };
      }
      if (c === C_RBRACK) {
        issues.push({ s: i, e: i + 1, msg: "Mismatched ']' — expected '}'", sev: 'error' });
        return { k: 'obj', s, e: i, keys, vals };
      }
      if (keys.length > 0 && commas === 0) {
        issues.push({ s: prevEnd, e: prevEnd, msg: 'Missing comma', sev: 'hint', code: 'missing-comma' });
      } else if (commas > 1) {
        issues.push({ s: before, e: i, msg: 'Duplicate comma', sev: 'hint', code: 'extra-comma' });
      }
      let key: AStr;
      if (c === C_QUOTE) {
        key = parseString();
      } else {
        const b = parseBare();
        const kv = text.slice(b.s, b.e);
        if (b.k !== 'str') {
          issues.push({ s: b.s, e: b.e, msg: `Object key '${kv}' must be a quoted string`, sev: 'error' });
        }
        key = { k: 'str', s: b.s, e: b.e, v: kv };
      }
      skipWs();
      const sepc = text.charCodeAt(i);
      if (sepc === C_COLON || sepc === C_EQ) {
        i++;
      } else {
        issues.push({ s: key.s, e: key.e, msg: `Missing ':' after key "${key.v}"`, sev: 'error' });
      }
      // BeamNG's reader treats commas as whitespace everywhere, so `"key":, {...}` is accepted in-game
      const strayAt = i;
      if (skipSep() > 0) {
        issues.push({ s: strayAt, e: i, msg: `Stray comma after "${key.v}":`, sev: 'warning', code: 'stray-comma' });
      }
      const vc = text.charCodeAt(i);
      if (i >= len || vc === C_RBRACE || vc === C_RBRACK) {
        issues.push({ s: key.s, e: key.e, msg: `Key "${key.v}" has no value`, sev: 'error' });
        keys.push(key);
        vals.push({ k: 'null', s: i, e: i });
        prevEnd = i;
        continue;
      }
      const v = parseValue();
      keys.push(key);
      vals.push(v);
      prevEnd = v.e;
    }
  }

  skipWs();
  if (i >= len) {
    return { root: null, issues };
  }
  const root = parseValue();
  skipSep();
  if (i < len) {
    // BeamNG ignores trailing garbage in some cases, but it is almost always a bracket mistake
    issues.push({ s: i, e: Math.min(len, i + 1), msg: 'Unexpected content after end of document (unbalanced brackets?)', sev: 'error' });
  }
  return { root, issues };
}

/** Converts an AST node to a plain JS value. */
export function toJs(node: ANode | null | undefined): any {
  if (!node) return undefined;
  switch (node.k) {
    case 'obj': {
      const o: Record<string, any> = {};
      for (let i = 0; i < node.keys.length; i++) {
        const key = node.keys[i].v;
        if (key === '__proto__') continue;
        o[key] = toJs(node.vals[i]);
      }
      return o;
    }
    case 'arr': {
      const a = new Array(node.items.length);
      for (let i = 0; i < a.length; i++) a[i] = toJs(node.items[i]);
      return a;
    }
    case 'str':
    case 'num':
    case 'bool':
      return node.v;
    default:
      return null;
  }
}

export function objGet(node: ANode | null | undefined, key: string): ANode | undefined {
  if (!node || node.k !== 'obj') return undefined;
  // last one wins, like a Lua table assignment
  for (let i = node.keys.length - 1; i >= 0; i--) {
    if (node.keys[i].v === key) return node.vals[i];
  }
  return undefined;
}

export function objEntries(node: AObj): Array<[AStr, ANode]> {
  const out: Array<[AStr, ANode]> = new Array(node.keys.length);
  for (let i = 0; i < node.keys.length; i++) out[i] = [node.keys[i], node.vals[i]];
  return out;
}

/** Precomputed line start offsets for offset <-> line/column conversion. */
export class LineIndex {
  readonly starts: number[];
  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }
  /** 0-based line */
  lineAt(offset: number): number {
    const s = this.starts;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** 0-based line / column */
  pos(offset: number): { line: number; col: number } {
    const line = this.lineAt(offset);
    return { line, col: offset - this.starts[line] };
  }
  offset(line: number, col: number): number {
    return (this.starts[Math.min(line, this.starts.length - 1)] ?? 0) + col;
  }
  lineStart(line: number): number {
    return this.starts[line] ?? this.text.length;
  }
  lineEnd(line: number): number {
    // offset of the line break (exclusive of \r\n)
    let e = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    if (e > 0 && this.text.charCodeAt(e - 1) === 13) e--;
    return e;
  }
}

/** Finds the deepest AST path containing the offset. Path goes root -> leaf. */
export function pathAt(root: ANode | null, offset: number): Array<{ node: ANode; key?: string; index?: number }> {
  const path: Array<{ node: ANode; key?: string; index?: number }> = [];
  let cur: ANode | null = root;
  let key: string | undefined;
  let index: number | undefined;
  while (cur && offset >= cur.s && offset <= cur.e) {
    path.push({ node: cur, key, index });
    let next: ANode | null = null;
    if (cur.k === 'obj') {
      for (let i = 0; i < cur.vals.length; i++) {
        const k = cur.keys[i];
        const v = cur.vals[i];
        if (offset >= k.s && offset <= v.e) {
          if (offset >= v.s) {
            next = v;
            key = k.v;
            index = i;
          } else {
            // on the key itself
            path.push({ node: k, key: k.v, index: i });
            return path;
          }
          break;
        }
      }
    } else if (cur.k === 'arr') {
      for (let i = 0; i < cur.items.length; i++) {
        const v = cur.items[i];
        if (offset >= v.s && offset <= v.e) {
          next = v;
          key = undefined;
          index = i;
          break;
        }
        if (v.s > offset) break;
      }
    }
    cur = next;
  }
  return path;
}
