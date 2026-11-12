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

export function buildVantObf(source, seed, opts = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new BuildError('El script esta vacio');
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
  computeCaptures2(ast);
  const { root } = compile(ast, ast._capNames);
  const ops = shuffledOps(seed);
  const data = serializeRoot(root, ops);
  const code = emitRuntime(data, seed, ops);
  return { code, stats: { protos: countProtos(root), instrs: countInstrs(root), bytes: data.length } };
}

function countProtos(fn) { return 1 + fn.protos.reduce((n, c) => n + countProtos(c), 0); }
function countInstrs(fn) { return fn.code.length + fn.protos.reduce((n, c) => n + countInstrs(c), 0); }
