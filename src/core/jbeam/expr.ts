/**
 * Evaluator for JBeam "$=" expressions.
 *
 * In-game these are Lua expressions run in a sandbox (lua/common/jbeam/expressionParser.lua).
 * This is a small Lua-expression interpreter covering what that sandbox exposes:
 * arithmetic, comparisons, and/or/not, string concat, calls into the flattened math library
 * and the BeamNG helpers (round, clamp, case, ...), `$variables` and `$components.a.b` lookups.
 */

export type Scope = Record<string, any>;

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'var'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

type Ast =
  | { k: 'lit'; v: any }
  | { k: 'var'; name: string }
  | { k: 'id'; name: string }
  | { k: 'un'; op: string; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'call'; f: Ast; args: Ast[] }
  | { k: 'idx'; o: Ast; key: Ast }
  | { k: 'tbl'; items: Array<{ key?: Ast; val: Ast }> };

export class ExprError extends Error {}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d*(?:[eE][+-]?\d+)?)/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length || 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'var', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          j++;
          const e = src[j];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else {
          out += src[j];
        }
        j++;
      }
      toks.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..' || two === '//') {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%^()<>,.[]{}#='.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

const BIN_PREC: Record<string, [number, number]> = {
  or: [1, 1],
  and: [2, 2],
  '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
  '..': [9, 8], // right assoc
  '+': [10, 10], '-': [10, 10],
  '*': [11, 11], '/': [11, 11], '%': [11, 11], '//': [11, 11],
  '^': [14, 13], // right assoc
};
const UNARY_PREC = 12;

function parse(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => {
    const t = toks[p];
    return t.t === 'op' && t.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}'`);
    p++;
  };

  function binOp(): string | null {
    const t = toks[p];
    if (t.t === 'op' && BIN_PREC[t.v]) return t.v;
    if (t.t === 'id' && (t.v === 'and' || t.v === 'or')) return t.v;
    return null;
  }

  function primary(): Ast {
    const t = toks[p];
    let node: Ast;
    if (t.t === 'num') {
      p++;
      node = { k: 'lit', v: t.v };
    } else if (t.t === 'str') {
      p++;
      node = { k: 'lit', v: t.v };
    } else if (t.t === 'var') {
      p++;
      node = { k: 'var', name: t.v };
    } else if (t.t === 'id') {
      p++;
      if (t.v === 'true') node = { k: 'lit', v: true };
      else if (t.v === 'false') node = { k: 'lit', v: false };
      else if (t.v === 'nil') node = { k: 'lit', v: undefined };
      else node = { k: 'id', name: t.v };
    } else if (t.t === 'op' && t.v === '(') {
      p++;
      node = expr(0);
      expectOp(')');
    } else if (t.t === 'op' && t.v === '{') {
      p++;
      const items: Array<{ key?: Ast; val: Ast }> = [];
      while (!isOp('}')) {
        const t0 = toks[p];
        const t1 = toks[p + 1];
        if (t0.t === 'id' && t1.t === 'op' && t1.v === '=') {
          p += 2;
          items.push({ key: { k: 'lit', v: t0.v }, val: expr(0) });
        } else {
          items.push({ val: expr(0) });
        }
        if (isOp(',')) p++;
        else break;
      }
      expectOp('}');
      node = { k: 'tbl', items };
    } else {
      throw new ExprError('Unexpected token in expression');
    }
    // postfix
    for (;;) {
      if (isOp('(')) {
        p++;
        const args: Ast[] = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(expr(0));
            if (isOp(',')) p++;
            else break;
          }
        }
        expectOp(')');
        node = { k: 'call', f: node, args };
      } else if (isOp('.')) {
        p++;
        const id = toks[p];
        if (id.t !== 'id') throw new ExprError("Expected name after '.'");
        p++;
        node = { k: 'idx', o: node, key: { k: 'lit', v: id.v } };
      } else if (isOp('[')) {
        p++;
        const key = expr(0);
        expectOp(']');
        node = { k: 'idx', o: node, key };
      } else {
        return node;
      }
    }
  }

  function unary(): Ast {
    const t = toks[p];
    if ((t.t === 'op' && (t.v === '-' || t.v === '#')) || (t.t === 'id' && t.v === 'not')) {
      p++;
      const a = exprFrom(unary(), UNARY_PREC);
      return { k: 'un', op: t.v, a };
    }
    return primary();
  }

  function exprFrom(left: Ast, minPrec: number): Ast {
    for (;;) {
      const op = binOp();
      if (!op) return left;
      const [lp, rp] = BIN_PREC[op];
      if (lp < minPrec) return left;
      p++;
      let right = unary();
      right = exprFrom(right, rp + 1);
      left = { k: 'bin', op, a: left, b: right };
    }
  }

  function expr(minPrec: number): Ast {
    return exprFrom(unary(), minPrec);
  }

  const ast = expr(0);
  if (peek().t !== 'eof') throw new ExprError('Unexpected trailing tokens');
  return ast;
}

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);

const ENV: Record<string, any> = {
  // BeamNG helpers
  round: (x: number) => Math.floor(x + 0.5),
  square: (x: number) => x * x,
  clamp,
  smoothstep: (x: number) => {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  },
  smootherstep: (x: number) => {
    x = clamp(x, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
  },
  smoothmin: (a: number, b: number, k = 0.1) => {
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return b + (a - b) * h - k * h * (1 - h);
  },
  sign: (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0),
  case: (selector: any, ...args: any[]) => {
    let index = 0;
    if (typeof selector === 'boolean') index = selector ? 1 : 2;
    else if (typeof selector === 'number') index = Math.floor(selector);
    const v = args[index - 1];
    return v !== undefined ? v : args[args.length - 1];
  },
  print: (v: any) => v,
  // Lua math, flattened into the environment like the game does
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos,
  tan: Math.tan, asin: Math.asin, acos: Math.acos, exp: Math.exp, pow: Math.pow, sinh: Math.sinh,
  cosh: Math.cosh, tanh: Math.tanh,
  atan: (y: number, x?: number) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
  atan2: Math.atan2,
  log: (x: number, base?: number) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base)),
  log10: Math.log10,
  min: Math.min, max: Math.max,
  fmod: (a: number, b: number) => a % b,
  rad: (d: number) => (d * Math.PI) / 180,
  deg: (r: number) => (r * 180) / Math.PI,
  pi: Math.PI,
  huge: Infinity,
  random: () => 0.5,
  modf: (x: number) => Math.trunc(x),
  vec3: (x = 0, y = 0, z = 0) => ({ x, y, z }),
  concat: (t: any[], sep = '') => (Array.isArray(t) ? t.join(sep) : ''),
};
ENV.math = ENV;

function truthy(v: any): boolean {
  return v !== undefined && v !== null && v !== false;
}

function num(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  throw new ExprError(`attempt to perform arithmetic on a ${v === undefined || v === null ? 'nil' : typeof v} value`);
}

function lookupVar(scope: Scope, name: string): any {
  const v = scope[name];
  if (v !== null && typeof v === 'object' && 'val' in v) return v.val;
  return v;
}

function evalAst(a: Ast, scope: Scope): any {
  switch (a.k) {
    case 'lit':
      return a.v;
    case 'var':
      return lookupVar(scope, a.name);
    case 'id':
      return ENV[a.name];
    case 'un': {
      const v = evalAst(a.a, scope);
      if (a.op === '-') return -num(v);
      if (a.op === 'not') return !truthy(v);
      if (a.op === '#') return typeof v === 'string' || Array.isArray(v) ? v.length : 0;
      return undefined;
    }
    case 'bin': {
      if (a.op === 'and') {
        const l = evalAst(a.a, scope);
        return truthy(l) ? evalAst(a.b, scope) : l;
      }
      if (a.op === 'or') {
        const l = evalAst(a.a, scope);
        return truthy(l) ? l : evalAst(a.b, scope);
      }
      const l = evalAst(a.a, scope);
      const r = evalAst(a.b, scope);
      switch (a.op) {
        case '+': return num(l) + num(r);
        case '-': return num(l) - num(r);
        case '*': return num(l) * num(r);
        case '/': return num(l) / num(r);
        case '//': return Math.floor(num(l) / num(r));
        case '%': {
          const x = num(l), y = num(r);
          return x - Math.floor(x / y) * y;
        }
        case '^': return Math.pow(num(l), num(r));
        case '..': return String(l) + String(r);
        case '==': return l === r;
        case '~=': return l !== r;
        case '<': return l < r;
        case '>': return l > r;
        case '<=': return l <= r;
        case '>=': return l >= r;
      }
      return undefined;
    }
    case 'call': {
      const f = evalAst(a.f, scope);
      if (typeof f !== 'function') throw new ExprError('attempt to call a non-function value');
      return f(...a.args.map((x) => evalAst(x, scope)));
    }
    case 'idx': {
      const o = evalAst(a.o, scope);
      if (o === undefined || o === null) throw new ExprError('attempt to index a nil value');
      const key = evalAst(a.key, scope);
      // Lua arrays are 1-based
      if (Array.isArray(o) && typeof key === 'number') return o[key - 1];
      return o[key];
    }
    case 'tbl': {
      const arr: any[] = [];
      const obj: Record<string, any> = {};
      let hasKeys = false;
      for (const it of a.items) {
        if (it.key) {
          hasKeys = true;
          obj[String(evalAst(it.key, scope))] = evalAst(it.val, scope);
        } else {
          arr.push(evalAst(it.val, scope));
        }
      }
      return hasKeys ? obj : arr;
    }
  }
}

const cache = new Map<string, Ast | ExprError>();

/**
 * Evaluates a "$=..." expression string. Throws ExprError on failure.
 * The game returns nil on failure; callers decide how to surface it.
 */
export function evalExpression(expr: string, scope: Scope): any {
  let ast = cache.get(expr);
  if (ast === undefined) {
    const body = expr.startsWith('$=') ? expr.slice(2) : expr;
    try {
      if (/[^<>~=]=[^=]/.test(body)) throw new ExprError('Assignments are not supported inside expressions');
      ast = parse(body);
    } catch (e) {
      ast = e instanceof ExprError ? e : new ExprError(String(e));
    }
    if (cache.size > 20000) cache.clear();
    cache.set(expr, ast);
  }
  if (ast instanceof ExprError) throw ast;
  return evalAst(ast, scope);
}
