/**
 * Three-way merge of text, line by line, like `git merge-file` / diff3:
 *   base   = the file as it was on disk when EditorNG last read or saved it
 *   ours   = the text in EditorNG (with unsaved edits)
 *   theirs = the file now on disk (changed by another program)
 * Regions changed on one side only are taken from that side; regions changed identically on both
 * sides are taken once; regions changed differently on both sides are conflicts.
 */

export type MergeChunk =
  | { kind: 'same'; lines: string[] }
  | { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[] };

export interface MergeResult {
  chunks: MergeChunk[];
  conflicts: number;
}

/** Lines with their line endings kept, so joining them gives the text back exactly. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(s, i + 1));
      s = i + 1;
    }
  }
  if (s < text.length) out.push(text.slice(s));
  return out;
}

/**
 * Myers O(ND) diff of two int sequences: returns, for each index of `a`, the matching index in
 * `b` (or -1). Matches are monotonic (a longest common subsequence).
 */
function lcsMatch(a: Int32Array, b: Int32Array): Int32Array {
  const n = a.length, m = b.length;
  const match = new Int32Array(n).fill(-1);
  // trim common prefix / suffix: the usual case is a few edits in a big file
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) {
    match[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) {
    match[n - 1 - suf] = m - 1 - suf;
    suf++;
  }
  const A = a.subarray(pre, n - suf), B = b.subarray(pre, m - suf);
  const N = A.length, M = B.length;
  if (!N || !M) return match;
  const max = N + M;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const nv = v;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && nv[off + k - 1] < nv[off + k + 1]) ? nv[off + k + 1] : nv[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      nv[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
    if (found >= 0) {
      trace.push(nv.slice());
      break;
    }
    v = nv;
  }
  // backtrack: trace[d] holds v before step d; trace[found+1] holds the final v
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      match[pre + x] = pre + y;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    match[pre + x] = pre + y;
  }
  return match;
}

function ids(lines: string[], table: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  lines.forEach((l, i) => {
    // compare without the line ending, so CRLF vs LF does not count as a change
    const key = l.replace(/\r?\n$/, '');
    let id = table.get(key);
    if (id === undefined) table.set(key, (id = table.size));
    out[i] = id;
  });
  return out;
}

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.replace(/\r?\n$/, '') === b[i].replace(/\r?\n$/, ''));

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const O = splitLines(base), A = splitLines(ours), B = splitLines(theirs);
  const table = new Map<string, number>();
  const o = ids(O, table), a = ids(A, table), b = ids(B, table);
  const ma = lcsMatch(o, a), mb = lcsMatch(o, b);
  const chunks: MergeChunk[] = [];
  let conflicts = 0;
  const pushSame = (lines: string[]) => {
    if (!lines.length) return;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === 'same') last.lines.push(...lines);
    else chunks.push({ kind: 'same', lines: [...lines] });
  };
  let i = 0, j = 0, k = 0;
  while (i < O.length || j < A.length || k < B.length) {
    if (i < O.length && ma[i] === j && mb[i] === k) {
      // stable line: unchanged on both sides (ours' copy keeps our line ending)
      pushSame([A[j]]);
      i++;
      j++;
      k++;
      continue;
    }
    // next base line that both sides still have, after the current position
    let n = i;
    while (n < O.length && !(ma[n] >= j && mb[n] >= k)) n++;
    const oe = n, ae = n < O.length ? ma[n] : A.length, be = n < O.length ? mb[n] : B.length;
    const oc = O.slice(i, oe), ac = A.slice(j, ae), bc = B.slice(k, be);
    if (eq(oc, ac)) pushSame(bc);
    else if (eq(oc, bc) || eq(ac, bc)) pushSame(ac);
    else if (oc.length === ac.length && oc.length === bc.length) {
      // same shape on all sides (values edited in place, e.g. node rows): merge line by line, so
      // only the lines both sides changed conflict, not their changed neighbours
      for (let x = 0; x < oc.length; x++) {
        const [ol, al, bl] = [[oc[x]], [ac[x]], [bc[x]]];
        if (eq(ol, al)) pushSame(bl);
        else if (eq(ol, bl) || eq(al, bl)) pushSame(al);
        else {
          chunks.push({ kind: 'conflict', base: ol, ours: al, theirs: bl });
          conflicts++;
        }
      }
    } else {
      chunks.push({ kind: 'conflict', base: oc, ours: ac, theirs: bc });
      conflicts++;
    }
    i = oe;
    j = ae;
    k = be;
  }
  return { chunks, conflicts };
}

export type Resolution = 'ours' | 'theirs' | 'both';

/** Text of a merge, each conflict resolved as chosen (default: ours). */
export function mergedText(r: MergeResult, choose: (index: number) => Resolution = () => 'ours'): string {
  const lines: string[] = [];
  let c = 0;
  for (const ch of r.chunks) {
    if (ch.kind === 'same') {
      lines.push(...ch.lines);
      continue;
    }
    const pick = choose(c++);
    lines.push(...(pick === 'ours' ? ch.ours : pick === 'theirs' ? ch.theirs : [...ch.ours, ...ch.theirs]));
  }
  // a line that was last in its file (no newline) and now has lines after it gets one
  const eol = lines.some((l) => l.endsWith('\r\n')) ? '\r\n' : '\n';
  return lines.map((l, i) => (i < lines.length - 1 && !l.endsWith('\n') ? l + eol : l)).join('');
}
