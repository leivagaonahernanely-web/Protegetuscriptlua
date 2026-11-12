// VantObf - Parser Lua 5.1 + Luau (asignaciones compuestas, continue)
import { tokenize, LexError } from './lexer.js';

export class ParseError extends Error { constructor(msg, line) { super(`Linea ${line}: ${msg}`); this.line = line; } }

const BINPREC = {
  'or': [1,1], 'and': [2,2],
  '<': [3,3], '>': [3,3], '<=': [3,3], '>=': [3,3], '~=': [3,3], '==': [3,3], '!=': [3,3],
  '|': [4,4], '~': [5,5], '&': [6,6], '<<': [7,7], '>>': [7,7],
  '..': [9,8],
  '+': [10,10], '-': [10,10],
  '*': [11,11], '/': [11,11], '//': [11,11], '%': [11,11],
  '^': [14,13],
};
const UNPREC = { 'not': 12, '-': 12, '#': 12 };

const ASSIGN_OPS = new Set(['+=','-=','*=','/=','%=','^=','..=']);

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const at = (t, v) => toks[p].type === t && (v === undefined || toks[p].value === v);
  const atKw = v => at('kw', v);
  const atP = v => at('punct', v);
  function next() { const t = toks[p++]; return t; }
  function expect(t, v) {
    const tok = toks[p];
    if (tok.type !== t || (v !== undefined && tok.value !== v))
      throw new ParseError(`se esperaba ${v || t}, llego ${tok.type}:${tok.value}`, tok.line);
    return next();
  }
  function checkEnd(tok) { return tok.type === 'eof' || (tok.type === 'kw' && ['end','else','elseif','until'].includes(tok.value)); }

  function parseBlock() {
    const stats = [];
    while (true) {
      const tok = peek();
      if (checkEnd(tok)) break;
      if (atP(';')) { next(); continue; }
      if (atKw('return')) { stats.push(parseReturn()); break; }
      if (atKw('break')) { next(); stats.push({ t: 'Break' }); continue; }
      if (atKw('continue')) { next(); stats.push({ t: 'Continue' }); continue; }
      stats.push(parseStat());
    }
    return stats;
  }

  function parseReturn() {
    const line = peek().line;
    next(); // return
    let exprs = [];
    if (!checkEnd(peek()) && !atP(';')) exprs = parseExprList();
    if (atP(';')) next();
    return { t: 'Return', exprs, line };
  }

  function parseName() { return expect('name').value; }

  function funcNameParts() {
    // a.b.c.d(:e)?
    const parts = [parseName()];
    let method = null;
    while (atP('.') ) { next(); parts.push(parseName()); }
    if (atP(':')) { next(); method = parseName(); }
    return { parts, method };
  }

  function parseFuncBody(nameHint) {
    expect('punct', '(');
    const params = [];
    let isVararg = false;
    if (!atP(')')) {
      while (true) {
        if (at('name')) params.push(next().value);
        else if (atP('...')) { next(); isVararg = true; break; }
        else throw new ParseError('parametro invalido', peek().line);
        if (atP(',')) { next(); continue; }
        break;
      }
    }
    expect('punct', ')');
    const body = parseBlock();
    expect('kw', 'end');
    return { t: 'Func', params, isVararg, body, name: nameHint };
  }

  function parseStat() {
    const line = peek().line;
    if (atKw('if')) {
      next();
      const clauses = [];
      const cond = parseExpr();
      expect('kw', 'then');
      clauses.push({ cond, body: parseBlock() });
      let orelse = null;
      while (true) {
        if (atKw('elseif')) { next(); const c = parseExpr(); expect('kw', 'then'); clauses.push({ cond: c, body: parseBlock() }); continue; }
        if (atKw('else')) { next(); orelse = parseBlock(); }
        expect('kw', 'end');
        break;
      }
      return { t: 'If', clauses, orelse, line };
    }
    if (atKw('while')) {
      next(); const cond = parseExpr(); expect('kw', 'do');
      const body = parseBlock(); expect('kw', 'end');
      return { t: 'While', cond, body, line };
    }
    if (atKw('repeat')) {
      next(); const body = parseBlock(); expect('kw', 'until');
      const cond = parseExpr();
      return { t: 'Repeat', body, cond, line };
    }
    if (atKw('for')) {
      next();
      const n1 = parseName();
      if (atP('=')) {
        next(); const from = parseExpr(); expect('punct', ','); const to = parseExpr();
        let step = null;
        if (atP(',')) { next(); step = parseExpr(); }
        expect('kw', 'do');
        const body = parseBlock(); expect('kw', 'end');
        return { t: 'NumFor', name: n1, from, to, step, body, line };
      }
      const names = [n1];
      while (atP(',')) { next(); names.push(parseName()); }
      expect('kw', 'in');
      const exprs = parseExprList();
      expect('kw', 'do');
      const body = parseBlock(); expect('kw', 'end');
      return { t: 'GenFor', names, exprs, body, line };
    }
    if (atKw('function')) {
      next();
      const { parts, method } = funcNameParts();
      // a.b.c -> target index chain; method -> ':' implicit self
      const fn = parseFuncBody(parts.join('.'));
      if (method) { fn.params.unshift('self'); fn.name = parts.join('.') + ':' + method; }
      return { t: 'FuncStat', target: { parts, method }, fn, line };
    }
    if (atKw('local')) {
      next();
      if (atKw('function')) {
        next();
        const name = parseName();
        const fn = parseFuncBody(name);
        return { t: 'LocalFunc', name, fn, line };
      }
      const names = [parseName()];
      // anotaciones de tipo Luau: : T
      skipTypeAnnotation();
      while (atP(',')) { next(); names.push(parseName()); skipTypeAnnotation(); }
      let exprs = [];
      if (atP('=')) { next(); exprs = parseExprList(); }
      return { t: 'Local', names, exprs, line };
    }
    if (atKw('do')) { next(); const body = parseBlock(); expect('kw', 'end'); return { t: 'Do', body, line }; }
    // stat que empieza por expresion: asignacion o llamada
    return parseExprStat(line);
  }

  function skipTypeAnnotation() {
    if (!atP(':')) return;
    next();
    // consume una anotacion de tipo simplificada (nombres, <>, (), |, ?, tablas)
    let depth = 0;
    while (true) {
      const tok = peek();
      if (tok.type === 'name' || tok.type === 'str' || tok.type === 'num') { next(); continue; }
      if (tok.type === 'punct' && ['<','(','{','[','?',',','>','|','&',')','}',']','.'].includes(tok.value)) {
        if (['<','(','{','['].includes(tok.value)) depth++;
        else if (['>','}',']'].includes(tok.value)) depth--;
        else if (tok.value === ')') { if (depth > 0) depth--; }
        next(); continue;
      }
      break;
    }
  }

  function parseExprStat(line) {
    const first = parseSuffixed();
    // llamada
    if (first.t === 'Call') {
      // Luau: f() ... no compound; compound solo sobre vars
      return { t: 'ExprStat', expr: first, line };
    }
    // asignacion
    const targets = [first];
    while (atP(',')) { next(); targets.push(parseSuffixed()); }
    if (atP('=')) { next(); const exprs = parseExprList(); for (const tg of targets) if (tg.t !== 'Index' && tg.t !== 'Name') throw new ParseError('no se puede asignar a esta expresion', line); return { t: 'Assign', targets, exprs, line }; }
    if (at('punct') && ASSIGN_OPS.has(peek().value)) {
      const op = next().value;
      const expr = parseExpr();
      for (const tg of targets) if (tg.t !== 'Index' && tg.t !== 'Name') throw new ParseError('no se puede asignar a esta expresion', line);
      if (targets.length !== 1) throw new ParseError('la asignacion compuesta solo acepta un objetivo', line);
      return { t: 'CompAssign', op: op.slice(0, -1), target: first, expr, line };
    }
    throw new ParseError('declaracion invalida', line);
  }

  function parsePrimary() {
    if (at('name')) { const name = next().value; return { t: 'Name', name, line: toks[p-1].line }; }
    if (atP('(')) { next(); const e = parseExpr(); expect('punct', ')'); return { t: 'Paren', e, line: e.line }; }
    throw new ParseError(`expresion inesperada ${peek().type}:${peek().value}`, peek().line);
  }

  function parseSuffixed() {
    let base = parsePrimary();
    while (true) {
      if (atP('.')) { next(); const nm = parseName(); base = { t: 'Index', obj: base, key: { t: 'Str', v: nm }, line: base.line }; continue; }
      if (atP('[')) { next(); const k = parseExpr(); expect('punct', ']'); base = { t: 'Index', obj: base, key: k, line: base.line }; continue; }
      if (atP(':')) { next(); const nm = parseName(); const args = parseArgs(); base = { t: 'Call', func: base, method: nm, args, line: base.line }; continue; }
      if (atP('(') || atP('{') || at('str')) { const args = parseArgs(); base = { t: 'Call', func: base, args, line: base.line }; continue; }
      break;
    }
    return base;
  }

  function parseArgs() {
    if (atP('(')) {
      next();
      const args = [];
      if (!atP(')')) args.push(...parseExprList());
      expect('punct', ')');
      return args;
    }
    if (atP('{')) return [parseTable()];
    if (at('str')) return [ { t: 'Str', v: next().value } ];
    throw new ParseError('argumentos de llamada invalidos', peek().line);
  }

  function parseTable() {
    const line = peek().line;
    expect('punct', '{');
    const entries = [];
    while (!atP('}')) {
      if (atP('[')) {
        next(); const k = parseExpr(); expect('punct', ']'); expect('punct', '=');
        entries.push({ k, v: parseExpr() });
      } else if (at('name') && toks[p+1].type === 'punct' && toks[p+1].value === '=') {
        const nm = next().value; next();
        entries.push({ k: { t: 'Str', v: nm }, v: parseExpr() });
      } else {
        entries.push({ v: parseExpr() });
      }
      if (atP(',') || atP(';')) { next(); continue; }
      break;
    }
    expect('punct', '}');
    return { t: 'Table', entries, line };
  }

  function parseExprList() {
    const out = [parseExpr()];
    while (atP(',')) { next(); out.push(parseExpr()); }
    return out;
  }

  function parseSimple() {
    const tok = peek();
    if (tok.type === 'num') { next(); return { t: 'Num', v: tok.value, line: tok.line }; }
    if (tok.type === 'str') { next(); return { t: 'Str', v: tok.value, line: tok.line }; }
    if (atKw('nil')) { next(); return { t: 'Nil', line: tok.line }; }
    if (atKw('true')) { next(); return { t: 'True', line: tok.line };
    }
    if (atKw('false')) { next(); return { t: 'False', line: tok.line }; }
    if (atP('...')) { next(); return { t: 'Vararg', line: tok.line }; }
    if (atKw('function')) { next(); return parseFuncBody(null); }
    if (atP('{')) return parseTable();
    return parseSuffixed();
  }

  function parseBinExpr(limit) {
    let left;
    const tok = peek();
    if (tok.type === 'kw' && (tok.value === 'not')) { next(); left = { t: 'Un', op: 'not', e: parseBinExpr(UNPREC['not']) }; }
    else if (tok.type === 'punct' && (tok.value === '-' || tok.value === '#')) { next(); left = { t: 'Un', op: tok.value, e: parseBinExpr(UNPREC[tok.value]) }; }
    else left = parseSimple();
    while (true) {
      const op = peek();
      let prec = null;
      if (op.type === 'kw' && BINPREC[op.value]) prec = BINPREC[op.value];
      else if (op.type === 'punct' && BINPREC[op.value]) prec = BINPREC[op.value];
      if (!prec || prec[0] <= limit) break;
      next();
      const right = parseBinExpr(prec[1]);
      left = { t: 'Bin', op: op.value, l: left, r: right, line: op.line };
    }
    return left;
  }
  function parseExpr() { return parseBinExpr(0); }

  const block = parseBlock();
  const endTok = peek();
  if (endTok.type !== 'eof') {
    if (endTok.type === 'kw' && endTok.value === 'end') throw new ParseError('"end" sin bloque abierto', endTok.line);
    throw new ParseError(`token inesperado ${endTok.type}:${endTok.value}`, endTok.line);
  }
  return block;
}
