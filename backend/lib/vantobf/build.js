// VantObf - pipeline: macros -> capturas -> parse -> compilar -> serializar -> runtime
import { preprocess, tokensToSource } from './macros.js';
import { parse, ParseError } from './parser.js';
import { LexError } from './lexer.js';
import { compile, emitRuntime, shuffledOps, serializeRoot, OP, VantError } from './vm.js';

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
    if (e.t === 'Func') annotateFn(e); // anotar y SEGUIR: los Func anidados (dentro de otro Func) tambien necesitan _capNames
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

// Expande cosas de Luau que el nucleo Lua 5.1 no tiene, antes del lexer:
//  - strings interpoladas `hola {nombre}` -> ("hola " .. tostring(nombre) .. "")
//  - atributos @native / @checked -> linea descartada
function expandLuau(src) {
  let out = '';
  let i = 0, line = 1;
  const n = src.length;
  const err = (msg) => { throw new LexError(msg, line); };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; out += c; i++; continue; }
    // comentarios
    if (c === '-' && src[i+1] === '-') {
      if (src[i+2] === '[') {
        let j = i+3, lvl = 0;
        while (src[j] === '=') { lvl++; j++; }
        if (src[j] === '[') {
          const close = ']' + '='.repeat(lvl) + ']';
          const end = src.indexOf(close, j+1);
          const stop = end === -1 ? n : end + close.length;
          for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
          out += src.slice(i, stop); i = stop; continue;
        }
      }
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      out += src.slice(i, j); i = j; continue;
    }
    // cadenas normales, sin tocar
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      const stop = Math.min(j + 1, n);
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      out += src.slice(i, stop); i = stop; continue;
    }
    // cadenas largas [[..]], sin tocar
    if (c === '[') {
      let j = i + 1, lvl = 0;
      while (src[j] === '=') { lvl++; j++; }
      if (src[j] === '[') {
        const close = ']' + '='.repeat(lvl) + ']';
        const end = src.indexOf(close, i);
        const stop = end === -1 ? n : end + close.length;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        out += src.slice(i, stop); i = stop; continue;
      }
    }
    // atributos @algo: descartar la linea
    if (c === '@' && /[A-Za-z_]/.test(src[i+1] || '')) {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      out += ' '; i = j; continue;
    }
    // string interpolado
    if (c === '`') {
      i++;
      let lit = '';
      const parts = [];
      while (true) {
        if (i >= n) err('cadena interpolada sin cerrar');
        const d = src[i];
        if (d === '\n') { line++; lit += d; i++; continue; }
        if (d === '`') { i++; break; }
        if (d === '\\') {
          i++;
          const e2 = src[i];
          if (i >= n) err('escape sin caracter en string interpolada');
          if (e2 === '`' || e2 === '{' || e2 === '}') { lit += e2; i++; continue; }
          if (e2 === '\n') { lit += '\n'; i++; line++; continue; }
          const simple = { n:'\n', t:'\t', r:'\r', a:'\x07', b:'\b', f:'\f', v:'\v', '\\':'\\', '"':'"', "'":"'" };
          if (simple[e2] !== undefined) { lit += simple[e2]; i++; continue; }
          if (e2 === 'z') { i++; while (i < n && (src[i] === ' ' || src[i] === '\n' || src[i] === '\t' || src[i] === '\r')) { if (src[i] === '\n') line++; i++; } continue; }
          if (e2 === 'x' || e2 === 'X') {
            const m3 = src.slice(i+1).match(/^[0-9a-fA-F]{1,2}/);
            if (!m3) err('escape \\x mal formado en string interpolada');
            lit += String.fromCharCode(parseInt(m3[0], 16)); i += 1 + m3[0].length; continue;
          }
          if (e2 === 'u' || e2 === 'U') {
            const m3 = src.slice(i+1).match(/^\{([0-9a-fA-F]+)\}/);
            if (!m3) err('escape \\u mal formado en string interpolada');
            const cp = parseInt(m3[1], 16);
            if (cp < 0x80) lit += String.fromCharCode(cp);
            else if (cp < 0x800) lit += String.fromCharCode(0xC0 | (cp >> 6)) + String.fromCharCode(0x80 | (cp & 63));
            else if (cp < 0x10000) lit += String.fromCharCode(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
            else lit += String.fromCharCode(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
            i += 1 + m3[0].length; continue;
          }
          if (e2 >= '0' && e2 <= '9') {
            const m3 = src.slice(i).match(/^\d{1,3}/);
            lit += String.fromCharCode(parseInt(m3[0], 10)); i += m3[0].length; continue;
          }
          err('escape desconocido \\' + e2 + ' en string interpolada');
        }
        if (d === '{') {
          i++;
          let ex = '', depth = 1, q = false;
          while (i < n && depth > 0) {
            const e3 = src[i];
            if (q) {
              if (e3 === '\\') { ex += src.slice(i, i + 2); i += 2; continue; }
              if (e3 === q) q = false;
              ex += e3; i++; continue;
            }
            if (e3 === '\n') { line++; ex += e3; i++; continue; }
            if (e3 === '"' || e3 === "'") { q = e3; ex += e3; i++; continue; }
            if (e3 === '{') { depth++; ex += e3; i++; continue; }
            if (e3 === '}') { depth--; if (depth === 0) { i++; break; } ex += e3; i++; continue; }
            ex += e3; i++;
          }
          if (depth > 0) err('llave sin cerrar en string interpolada');
          const ex2 = ex.trim();
          if (!ex2) err('expresion vacia en string interpolada');
          parts.push({ lit, ex: ex2 }); lit = '';
          continue;
        }
        lit += d; i++;
      }
      const enc = (t) => '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
      let expr;
      if (parts.length === 0) expr = enc(lit);
      else {
        const segs = [];
        for (const p of parts) { if (p.lit) segs.push(enc(p.lit)); segs.push('tostring(' + p.ex + ')'); }
        if (lit) segs.push(enc(lit));
        expr = '(' + segs.join(' .. ') + ')';
      }
      out += expr;
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function buildVantObf(source, seed, opts = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new BuildError('El script esta vacio');
  const mode = opts.mode === 'low' || opts.mode === 'high' ? opts.mode : 'medium';
  const macros = scanVantMacros(source);
  try {
    source = expandLuau(source);
    let pre;
    try {
      pre = preprocess(source, { fileName: opts.fileName || 'script.lua' });
    } catch (err) {
      if (err instanceof ParseError || err instanceof LexError) throw new BuildError(err.message);
      throw err;
    }
    const srcText = tokensToSource(pre);
    let ast;
    try {
      ast = parse(srcText);
    } catch (err) {
      if (err instanceof ParseError || err instanceof LexError) throw new BuildError(err.message);
      throw err;
    }
    annotateMacros(ast, macros);
    computeCaptures2(ast);
    const { root } = compile(ast, ast._capNames);
    const ops = shuffledOps(seed, mode !== 'low');
    const data = serializeRoot(root, ops, { seed, constFlag: mode === 'low' ? 0 : 3 });
    const code = emitRuntime(data, seed, ops, {
      layers: mode === 'high' ? 2 : 1,
      mangle: true,
      junk: mode === 'high',
      guard: typeof opts.guard === 'string' && /^[0-9a-f]{32}$/.test(opts.guard) ? opts.guard : '',
      antiEnv: opts.antiEnv !== false,
    });
    return { code, stats: { protos: countProtos(root), instrs: countInstrs(root), bytes: data.length, mode } };
  } catch (err) {
    if (err instanceof BuildError) throw err;
    if (err instanceof LexError || err instanceof ParseError || err instanceof VantError) {
      throw new BuildError('El ofuscador no soporta esta parte del codigo (' + err.message + ')');
    }
    throw err;
  }
}

function countProtos(fn) { return 1 + fn.protos.reduce((n, c) => n + countProtos(c), 0); }
function countInstrs(fn) { return fn.code.length + fn.protos.reduce((n, c) => n + countInstrs(c), 0); }
