// VantObf - Preprocesador de macros sobre el stream de tokens
// Directivas (una por linea, tras --#):
//   --#define NAME tokens...
//   --#define NAME(a, b) tokens...
//   --#undef NAME
//   --#ifdef NAME / --#ifndef NAME / --#if expr / --#elif expr / --#else / --#endif
//   --#error mensaje
// En expresiones de #if se soporta defined(NAME), enteros, + - * / % ( ) < > <= >= == != && || y macros ya definidas.
// Builtin: __LINE__ (linea actual), __FILE__ (nombre del script).
import { tokenize } from './lexer.js';
import { ParseError } from './parser.js';

function isIdent(t) { return t.type === 'name'; }

export function preprocess(src, opts = {}) {
  const fileName = opts.fileName || 'script.lua';
  const all = tokenize(src);
  const macros = new Map(); // name -> { params: null|[names], body: [tokens] }
  const out = [];
  const condStack = []; // { active, taken }

  function directiveError(msg) { throw new ParseError(`macro: ${msg}`, curLine); }
  let curLine = 1;

  function evalConstExpr(tokens) {
    let i = 0;
    const evalTok = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'name' || t.type === 'kw') {
        if (t.value === 'defined') {
          let j = i + 1, paren = false;
          if (tokens[j] && tokens[j].type === 'punct' && tokens[j].value === '(') { paren = true; j++; }
          if (!tokens[j] || (tokens[j].type !== 'name' && tokens[j].type !== 'kw')) directiveError('defined() requiere un nombre');
          const name = tokens[j].value; j++;
          if (paren) {
            if (!tokens[j] || tokens[j].type !== 'punct' || tokens[j].value !== ')') directiveError('falta ) en defined()');
            j++;
          }
          evalTok.push({ type: 'num', value: macros.has(name) ? 1 : 0, line: t.line });
          i = j; continue;
        }
        if (t.value === 'true') { evalTok.push({ type: 'num', value: 1, line: t.line }); i++; continue; }
        if (t.value === 'false') { evalTok.push({ type: 'num', value: 0, line: t.line }); i++; continue; }
        if (t.value === '__LINE__') { evalTok.push({ type: 'num', value: t.line, line: t.line }); i++; continue; }
        if (t.value === '__FILE__') { evalTok.push({ type: 'str', value: fileName, line: t.line }); i++; continue; }
        const m = macros.get(t.value);
        if (m && !m.params) { evalTok.push(...m.body.map(x => ({ ...x }))); i++; continue; }
        evalTok.push({ type: 'num', value: 0, line: t.line }); i++; continue;
      }
      evalTok.push(t); i++;
    }
    let p2 = 0;
    const peek2 = () => evalTok[p2];
    const eat2 = () => evalTok[p2++];
    function prim() {
      const t = peek2();
      if (!t) directiveError('expresion #if incompleta');
      if (t.type === 'num') { eat2(); return t.value; }
      if (t.type === 'punct' && t.value === '(') { eat2(); const v = tern(); if (!peek2() || peek2().value !== ')') directiveError('falta )'); eat2(); return v; }
      if (t.type === 'punct' && (t.value === '!' || t.value === '-')) { eat2(); const v = prim(); return t.value === '!' ? (v ? 0 : 1) : -v; }
      directiveError(`token inesperado en #if: ${t.value}`);
    }
    function mul() {
      let v = prim();
      while (peek2() && peek2().type === 'punct' && ['*','/','%'].includes(peek2().value)) {
        const op = eat2().value; const r = prim();
        if ((op === '/' || op === '%') && r === 0) directiveError('division por cero en #if');
        v = op === '*' ? v * r : op === '/' ? Math.floor(v / r) : ((v % r) + r) % r;
      }
      return v;
    }
    function add() {
      let v = mul();
      while (peek2() && peek2().type === 'punct' && ['+','-'].includes(peek2().value)) {
        const op = eat2().value; const r = mul();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function cmp() {
      let v = add();
      while (peek2() && peek2().type === 'punct' && ['<','>','<=','>=','==','!='].includes(peek2().value)) {
        const op = eat2().value; const r = add();
        v = op === '<' ? (v < r ? 1 : 0) : op === '>' ? (v > r ? 1 : 0) : op === '<=' ? (v <= r ? 1 : 0) : op === '>=' ? (v >= r ? 1 : 0) : op === '==' ? (v === r ? 1 : 0) : (v !== r ? 1 : 0);
      }
      return v;
    }
    function andOr() {
      let v = cmp();
      while (peek2() && peek2().type === 'punct' && ['&&','||'].includes(peek2().value)) {
        const op = eat2().value; const r = cmp();
        v = op === '&&' ? (v && r ? 1 : 0) : (v || r ? 1 : 0);
      }
      return v;
    }
    function tern() {
      const c = andOr();
      if (peek2() && peek2().type === 'punct' && peek2().value === '?') {
        eat2(); const a = tern();
        if (!peek2() || peek2().value !== ':') directiveError('falta : en ternario de #if');
        eat2(); const b = tern();
        return c ? a : b;
      }
      return c;
    }
    const v = tern();
    if (p2 < evalTok.length) directiveError(`tokens sobrantes en #if: ${evalTok[p2].value}`);
    return v;
  }

  // expande tokens con macros; ctx = { banned: Set, args: Map }
  function expandTokens(tokens, depth) {
    if (depth > 100) directiveError('macros con recursion infinita');
    const res = [];
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'name') {
        if (t.value === '__LINE__') { res.push({ type: 'num', value: t.line, line: t.line }); i++; continue; }
        if (t.value === '__FILE__') { res.push({ type: 'str', value: fileName, line: t.line }); i++; continue; }
        const m = macros.get(t.value);
        if (m && !ctxBanned(res, t)) {
          if (m.params) {
            // buscar lista de argumentos
            if (!(tokens[i+1] && tokens[i+1].type === 'punct' && tokens[i+1].value === '(')) { res.push(t); i++; continue; }
            let j = i + 2, level = 1;
            const args = [[]];
            while (j < tokens.length) {
              const a = tokens[j];
              if (a.type === 'punct' && a.value === '(') level++;
              if (a.type === 'punct' && a.value === ')') { level--; if (level === 0) break; }
              if (a.type === 'punct' && a.value === ',' && level === 1) { args.push([]); j++; continue; }
              args[args.length-1].push(a); j++;
            }
            if (j >= tokens.length) directiveError(`falta ) en llamada a ${t.value}`);
            // argumentos vacios se permiten; expandir cada uno
            const expArgs = args.map(a => expandTokens(a, depth + 1));
            if (expArgs.length !== m.params.length) directiveError(`${t.value} espera ${m.params.length} argumentos, llegaron ${expArgs.length}`);
            const subst = new Map(m.params.map((pn, ix) => [pn, expArgs[ix]]));
            const body = m.body.map(x => ({ ...x }));
            // sustituir params por args
            const replaced = [];
            for (const b of body) {
              if (b.type === 'name' && subst.has(b.value)) replaced.push(...subst.get(b.value).map(y => ({ ...y, line: b.line })));
              else replaced.push(b);
            }
            res.push(...expandTokens(replaced, depth + 1));
            i = j + 1; continue;
          } else {
            const body = m.body.map(x => ({ ...x, line: t.line }));
            res.push(...expandTokens(body, depth + 1));
            i++; continue;
          }
        }
      }
      res.push(t); i++;
    }
    return res;
  }
  // evita re-expandir un nombre que acaba de salir de una expansion en cadena (res[0])
  function ctxBanned(res, t) {
    return false; // simple: permite re-expansion controlada por depth
  }

  // agrupar tokens por linea (los dir son lineas propias)
  const groups = [];
  for (const t of all) {
    if (t.type === 'eof') break;
    const last = groups[groups.length - 1];
    if (t.type === 'dir') { groups.push({ dir: true, toks: [t] }); continue; }
    if (!last || last.dir || last.line !== t.line) groups.push({ dir: false, toks: [t], line: t.line });
    else last.toks.push(t);
  }
  for (const g of groups) {
    if (g.dir) {
    const t = g.toks[0];
    if (t.type === 'dir') {
      curLine = t.line;
      const dtoks = tokenizeDirective(t.value, t.line);
      if (!dtoks.length) directiveError('directiva vacia');
      const d = dtoks[0];
      if (d.type !== 'name' && d.type !== 'kw') directiveError(`directiva desconocida: ${d.value}`);
      const rest = dtoks.slice(1);
      const active = condStack.every(c => c.active);
      switch (d.value) {
        case 'define': {
          if (!active) break;
          if (!rest.length || (rest[0].type !== 'name' && rest[0].type !== 'kw')) directiveError('#define requiere un nombre');
          const name = rest[0].value;
          let params = null, bodyStart = 1;
          if (rest[1] && rest[1].type === 'punct' && rest[1].value === '(' && rest[0].line === rest[1].line) {
            params = [];
            let j = 2;
            if (!(rest[j] && rest[j].type === 'punct' && rest[j].value === ')')) {
              while (true) {
                if (!rest[j] || rest[j].type !== 'name') directiveError('parametro invalido en #define');
                params.push(rest[j].value); j++;
                if (rest[j] && rest[j].type === 'punct' && rest[j].value === ',') { j++; continue; }
                break;
              }
            }
            if (!rest[j] || rest[j].type !== 'punct' || rest[j].value !== ')') directiveError('falta ) en #define');
            bodyStart = j + 1;
          }
          if (rest[bodyStart] && rest[bodyStart].type === 'punct' && rest[bodyStart].value === '=') bodyStart++;
          const body = rest.slice(bodyStart);
          if (!body.length) directiveError('#define sin cuerpo (los macros vacios no estan permitidos)');
          macros.set(name, { params, body });
          break;
        }
        case 'undef': {
          if (!active) break;
          if (!rest.length || (rest[0].type !== 'name' && rest[0].type !== 'kw')) directiveError('#undef requiere un nombre');
          macros.delete(rest[0].value);
          break;
        }
        case 'ifdef': case 'ifndef': {
          if (!rest.length || (rest[0].type !== 'name' && rest[0].type !== 'kw')) directiveError(`#${d.value} requiere un nombre`);
          const has = macros.has(rest[0].value);
          const open = d.value === 'ifdef' ? has : !has;
          condStack.push({ active: active && open, taken: open });
          break;
        }
        case 'if': {
          if (!active) { condStack.push({ active: false, taken: true }); break; }
          const v = evalConstExpr(rest) !== 0;
          condStack.push({ active: v, taken: v });
          break;
        }
        case 'elif': {
          if (!condStack.length) directiveError('#elif sin #if');
          const c = condStack[condStack.length - 1];
          if (c.taken) { c.active = false; break; }
          const outerActive = condStack.slice(0, -1).every(x => x.active);
          if (!outerActive) { c.active = false; break; }
          const v = evalConstExpr(rest) !== 0;
          c.active = v; c.taken = v;
          break;
        }
        case 'else': {
          if (!condStack.length) directiveError('#else sin #if');
          const c = condStack[condStack.length - 1];
          if (c.taken) { c.active = false; break; }
          const outerActive = condStack.slice(0, -1).every(x => x.active);
          c.active = outerActive; c.taken = true;
          break;
        }
        case 'endif': {
          if (!condStack.length) directiveError('#endif sin #if');
          condStack.pop();
          break;
        }
        case 'error': {
          if (active) directiveError(rest.map(t => t.value).join(' '));
          break;
        }
        default: directiveError(`directiva desconocida: #${d.value}`);
      }
      continue;
    }
    } else if (condStack.every(c => c.active)) out.push(...expandTokens(g.toks, 0));
  }
  if (condStack.length) throw new ParseError('macro: #if sin #endif', curLine);
  return out;
}

function tokenizeDirective(text, line) {
  const toks = tokenize(text + '\n');
  for (const t of toks) if (t.type !== 'eof') t.line = line;
  return toks.filter(t => t.type !== 'eof');
}

// reconstruye texto fuente desde tokens (para el parser)
export function tokensToSource(tokens) {
  let out = '', prev = null;
  for (const t of tokens) {
    if (prev && needsSpace(prev, t)) out += ' ';
    out += renderToken(t);
    prev = t;
  }
  return out;
}
function renderToken(t) {
  if (t.type === 'str') return "'" + t.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
  if (t.type === 'num') return String(t.value);
  if (t.type === 'eof') return '';
  return String(t.value);
}
function needsSpace(a, b) {
  const idA = a.type === 'name' || a.type === 'num' || a.type === 'kw';
  const idB = b.type === 'name' || b.type === 'num' || b.type === 'kw';
  if (idA && idB) return true;
  if (a.type === 'num' && b.type === 'punct' && (b.value === '.' || b.value === '..')) return true;
  if (a.type === 'punct' && b.type === 'punct') {
    const pair = a.value + b.value;
    if (['..','...','..=','==','~=','<=','>=','+=','-=','*=','/=','%=','^=','//','::'].includes(pair) && a.value.length + b.value.length === pair.length) return true;
  }
  if ((a.type === 'punct' && ['-', '-'].includes(a.value)) && b.type === 'punct' && b.value === '-' ) return true;
  return false;
}
