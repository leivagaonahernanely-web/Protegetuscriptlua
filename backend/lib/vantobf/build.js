// VantObf - pipeline: macros -> capturas -> parse -> compilar -> serializar -> runtime
import { preprocess, tokensToSource } from './macros.js';
import { parse, ParseError } from './parser.js';
import { compile, emitRuntime, shuffledOps, serializeRoot, OP } from './vm.js';

export class BuildError extends Error {}

// mejor: integrar fnNode directamente en el walker
export function computeCaptures2(ast) {
  const decls = []; // {fnNode, name, captured}
  const scopes = []; // {map, fnNode}
  let curFn = { pseudo: true };

  function push(newFn) {
    if (newFn) curFn = newFn;
    scopes.push({ map: new Map(), fnNode: curFn });
  }
  function pop() { scopes.pop(); curFn = scopes.length ? scopes[scopes.length - 1].fnNode : { pseudo: true }; }
  function declare(name) {
    const d = { fnNode: curFn, name, captured: false };
    decls.push(d);
    scopes[scopes.length - 1].map.set(name, d);
    return d;
  }
  function reference(name) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const d = scopes[i].map.get(name);
      if (d) {
        if (d.fnNode !== curFn) d.captured = true;
        return;
      }
    }
  }
  function walkExpr(e) {
    if (!e || typeof e !== 'object') return;
    switch (e.t) {
      case 'Name': reference(e.name); return;
      case 'Paren': walkExpr(e.e); return;
      case 'Index': walkExpr(e.obj); walkExpr(e.key); return;
      case 'Call': walkExpr(e.func); for (const a of e.args) walkExpr(a); return;
      case 'Func':
        push(e);
        for (const p of e.params) declare(p);
        walkBlock(e.body);
        pop();
        return;
      case 'Table': for (const en of e.entries) { if (en.k) walkExpr(en.k); walkExpr(en.v); } return;
      case 'Un': walkExpr(e.e); return;
      case 'Bin': walkExpr(e.l); walkExpr(e.r); return;
      default: return;
    }
  }
  function walkBlock(stats) { for (const st of stats) walkStat(st); }
  function walkStat(st) {
    switch (st.t) {
      case 'Local':
        for (const ex of st.exprs) walkExpr(ex);
        for (const nm of st.names) declare(nm);
        return;
      case 'LocalFunc': { declare(st.name); walkExpr(st.fn); return; }
      case 'FuncStat': walkExpr(st.fn); return;
      case 'Assign':
        for (const tg of st.targets) { if (tg.t === 'Name') reference(tg.name); else walkExpr(tg); }
        for (const ex of st.exprs) walkExpr(ex);
        return;
      case 'CompAssign':
        if (st.target.t === 'Name') reference(st.target.name); else walkExpr(st.target);
        walkExpr(st.expr);
        return;
      case 'ExprStat': walkExpr(st.expr); return;
      case 'If':
        for (const cl of st.clauses) { walkExpr(cl.cond); push(null); walkBlock(cl.body); pop(); }
        if (st.orelse) { push(null); walkBlock(st.orelse); pop(); }
        return;
      case 'While':
        walkExpr(st.cond); push(null); walkBlock(st.body); pop();
        return;
      case 'Repeat':
        push(null); walkBlock(st.body); walkExpr(st.cond); pop();
        return;
      case 'NumFor':
        walkExpr(st.from); walkExpr(st.to); if (st.step) walkExpr(st.step);
        push(null); declare(st.name); walkBlock(st.body); pop();
        return;
      case 'GenFor':
        for (const ex of st.exprs) walkExpr(ex);
        push(null);
        for (const nm of st.names) declare(nm);
        walkBlock(st.body);
        pop();
        return;
      case 'Do': push(null); walkBlock(st.body); pop(); return;
      case 'Return': for (const ex of st.exprs) walkExpr(ex); return;
      default: return;
    }
  }
  push(null); // raiz: curFn = pseudo
  walkBlock(ast);
  pop();
  const cap = new Set();
  for (const d of decls) if (d.captured && d.fnNode && d.fnNode.pseudo) cap.add(d.name);
  ast._capNames = cap;
  // anotar cada Func
  function annotateFn(fnNode) {
    const c = new Set();
    for (const d of decls) if (d.captured && d.fnNode === fnNode) c.add(d.name);
    fnNode._capNames = c;
  }
  function rec(e) {
    if (!e || typeof e !== 'object') return;
    if (e.t === 'Func') { annotateFn(e); return; }
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v === 'object' && v.t) rec(v);
    }
  }
  const walkAll = (stats) => { for (const st of stats) rec(st); };
  walkAll(ast);
  // FuncStat tiene fn anidado dentro de target? no: fn es campo directo
  return ast;
}

// Macros de rendimiento del Ofuscador 5: lineas "--VANT_MACRO(nivel)" justo encima de la funcion.
// Acepta niveles en espanol o ingles: bajo/low, medio/medium, alto/high, extremo/extreme.
const MACRO_ALIASES = { low: 'bajo', bajo: 'bajo', medium: 'medio', medio: 'medio', high: 'alto', alto: 'alto', extreme: 'extremo', extremo: 'extremo' };

function scanVantMacros(srcText) {
  const out = [];
  const lines = srcText.split('\n');
  const fnRe = /^(?:\s*)(?:local\s+)?function\s+([\w.:]+)\s*\(|^(?:\s*)(?:local\s+)?([\w.]+)\s*=\s*function\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*--\s*VANT_MACRO\s*\(\s*([A-Za-z]+)\s*\)/);
    if (!m) continue;
    const lvl = MACRO_ALIASES[m[1].toLowerCase()];
    if (!lvl) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (!lines[j].trim()) continue;
      const fm = lines[j].match(fnRe);
      if (fm) out.push({ name: fm[1] || fm[2], level: lvl });
      break;
    }
  }
  return out;
}

// Anota cada Func del arbol con el nivel de su macro (solo funciones con nombre, igual que el picker de la web).
// "extremo" se hereda a las funciones anidadas que no tienen macro propia.
function annotateMacros(ast, wanted) {
  if (!wanted.length) return;
  const map = new Map();
  for (const w of wanted) map.set(w.name, w.level);
  const roots = [];
  for (const st of ast) {
    if (st.t === 'FuncStat') {
      const key = st.target && (st.target.method || (st.target.parts && st.target.parts[st.target.parts.length - 1]));
      if (key && map.has(key)) { st.fn._macroLevel = map.get(key); roots.push(st.fn); }
    } else if (st.t === 'LocalFunc') {
      if (map.has(st.name)) { st.fn._macroLevel = map.get(st.name); roots.push(st.fn); }
    }
  }
  for (const rootFn of roots) {
    if (rootFn._macroLevel !== 'extremo') continue;
    (function inherit(e) {
      if (!e || typeof e !== 'object') return;
      if (e.t === 'Func') { if (!e._macroLevel) e._macroLevel = 'extremo'; }
      for (const k of Object.keys(e)) {
        const v = e[k];
        if (Array.isArray(v)) v.forEach(inherit);
        else if (v && typeof v === 'object' && v.t) inherit(v);
      }
    })(rootFn);
  }
}

export function buildVantObf(source, seed, opts = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new BuildError('El script esta vacio');
  const mode = opts.mode === 'low' || opts.mode === 'high' ? opts.mode : 'medium';
  const macros = scanVantMacros(source);
  let pre;
  try {
    pre = preprocess(source, { fileName: opts.fileName || 'script.lua' });
  } catch (err) {
    if (err instanceof ParseError) throw new BuildError(err.message);
    throw err;
  }
  const srcText = tokensToSource(pre);
  let ast;
  try {
    ast = parse(srcText);
  } catch (err) {
    if (err instanceof ParseError) throw new BuildError(err.message);
    throw err;
  }
  annotateMacros(ast, macros);
  computeCaptures2(ast);
  const { root } = compile(ast, ast._capNames);
  const ops = shuffledOps(seed, mode !== 'low');
  const data = serializeRoot(root, ops, { seed, constFlag: mode === 'low' ? 0 : 3 });
  const code = emitRuntime(data, seed, ops, {
    layers: mode === 'high' ? 2 : 1,
    mangle: mode === 'high',
    junk: mode === 'high',
    guard: typeof opts.guard === 'string' && /^[0-9a-f]{32}$/.test(opts.guard) ? opts.guard : '',
    antiEnv: opts.antiEnv !== false,
  });
  return { code, stats: { protos: countProtos(root), instrs: countInstrs(root), bytes: data.length, mode } };
}

function countProtos(fn) { return 1 + fn.protos.reduce((n, c) => n + countProtos(c), 0); }
function countInstrs(fn) { return fn.code.length + fn.protos.reduce((n, c) => n + countInstrs(c), 0); }
