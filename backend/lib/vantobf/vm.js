// VantObf - Compilador AST -> VM propia (bytecode + runtime Lua)
// Parte 1: compilador
import { ParseError } from './parser.js';

export const OP_NAMES = ['MOVE','LOADK','LOADBOOL','LOADNIL','GETGLOBAL','SETGLOBAL','GETUPVAL','SETUPVAL',
  'ADD','SUB','MUL','DIV','MOD','POW','UNM','NOT','LEN','CONCAT','EQ','LT','LE','JMP','TEST',
  'CALL','RETURN','CLOSURE','NEWTABLE','GETTABLE','SETTABLE','SELF','VARARG','SETLIST',
  'FORPREP','FORLOOP','TFORCALL','TFORLOOP','BAND','BOR','BXOR','SHL','SHR','BOXNEW','BOXGET','BOXSET',
  'GETTABLEK','SETTABLEK','ADDK','SUBK','MULK','DIVK','MODK','POWK','EQK','LTK','LEK'];
export const OP = {};
OP_NAMES.forEach((n, i) => { OP[n] = i; });

class VantError extends Error {}

class FnCtx {
  constructor(parent, isVararg) {
    this.parent = parent;
    this.isVararg = !!isVararg;
    this.locals = []; // {name, reg, box (index|-1), from}
    this.scopes = [];
    this.freeReg = 0;
    this.code = [];
    this.k = [];
    this.kMap = new Map();
    this.protos = [];
    this.upvals = new Map(); // name -> upval index
    this.upvalList = [];
    this.captured = new Set(); // nombres de locales capturados por funciones hijas
    this.nboxes = 0;
    this.breaks = [];
    this.continues = [];
    this.loopEnd = null;
    this.loopContinue = null;
  }
  newReg() { const r = this.freeReg; this.freeReg++; if (this.freeReg > (this.maxReg || 0)) this.maxReg = this.freeReg; return r; }
  bump(to) { if (to > this.freeReg) this.freeReg = to; if (this.freeReg > (this.maxReg || 0)) this.maxReg = this.freeReg; }
  addK(v) {
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 100000) {
      // normalizar enteros para reutilizar constantes
    }
    const key = typeof v === 'string' ? 's:' + v : 'n:' + v;
    if (this.kMap.has(key)) return this.kMap.get(key);
    const idx = this.k.length;
    this.k.push(v); this.kMap.set(key, idx);
    return idx;
  }
  findLocal(name) {
    for (let i = this.locals.length - 1; i >= 0; i--) if (this.locals[i].name === name) return this.locals[i];
    return null;
  }
  declareLocal(name) {
    const reg = this.newReg();
    const loc = { name, reg, box: -1, from: 'decl' };
    this.locals.push(loc);
    return loc;
  }
  declareLocalBoxed(name) {
    const reg = this.newReg();
    const box = this.nboxes++;
    const loc = { name, reg, box, from: 'decl' };
    this.locals.push(loc);
    return loc;
  }
}

function tryUpval(ctx, name) {
  try { upvalIndex(ctx, name); return true; }
  catch (err) { return false; }
}

function upvalIndex(ctx, name) {
  if (ctx.upvals.has(name)) return ctx.upvals.get(name);
  const parent = ctx.parent;
  if (!parent) throw new VantError('upvalue no resoluble: ' + name);
  const pLocal = parent.findLocal(name);
  let entry;
  if (pLocal) {
    entry = { kind: 1, idx: pLocal.box };
    parent.captured.add(name);
  } else {
    const pIdx = upvalIndex(parent, name);
    entry = { kind: 0, idx: pIdx };
  }
  const idx = ctx.upvalList.length;
  ctx.upvalList.push(entry);
  ctx.upvals.set(name, idx);
  return idx;
}

export function compile(ast, rootCaps) {
  const root = new FnCtx(null, true);
  root.capturedNames = rootCaps || new Set();
  compileBlock(root, ast, null);
  emit(root, OP.RETURN, 0, 1, 0);
  finishFrame(root);
  return { root, protos: collectProtos(root) };
}

function collectProtos(root, count) {
  const list = [];
  function walk(fn) {
    fn.pid = list.length + 1;
    list.push(fn);
    for (const c of fn.protos) walk(c);
  }
  walk(root);
  function resolve(fn) {
    for (const ins of fn.code) {
      if (ins.o === OP.CLOSURE && ins.pRef) { ins.b = ins.pRef.pid; delete ins.pRef; }
    }
    for (const c of fn.protos) resolve(c);
  }
  resolve(root);
  return list;
}

function finishFrame(fn) {
  fn.nr = Math.max(fn.maxReg || 0, fn.freeReg) + 1;
}

function emit(ctx, o, a, b, c) {
  ctx.code.push({ o, a, b, c });
  return ctx.code.length; // 1-indexado conceptualmente: pc de la siguiente
}

function emitJump(ctx) {
  const idx = ctx.code.length;
  ctx.code.push({ o: OP.JMP, a: 0, b: 0, c: 0, _jump: true });
  return idx;
}
function patchJump(ctx, idx, target) {
  // b = target - (idx+1) relativo a la siguiente instruccion (idx es 0-based; pcs 1-based)
  ctx.code[idx].b = target - (idx + 1);
}
function patchList(ctx, list, target) { for (const i of list) patchJump(ctx, i, target); }

function beginScope(ctx) { ctx.scopes.push({ base: ctx.locals.length, regBase: ctx.freeReg }); }
function endScope(ctx) {
  const sc = ctx.scopes.pop();
  ctx.locals.length = sc.base;
  ctx.freeReg = sc.regBase;
}

function isTruthCheckNeeded() { return true; }

// compila una expresion en el registro dst
function compileExpr(ctx, e, dst) {
  switch (e.t) {
    case 'Num': emit(ctx, OP.LOADK, dst, ctx.addK(e.v), 0); return;
    case 'Str': emit(ctx, OP.LOADK, dst, ctx.addK(e.v), 0); return;
    case 'Nil': emit(ctx, OP.LOADNIL, dst, 0, 0); return;
    case 'True': emit(ctx, OP.LOADBOOL, dst, 1, 0); return;
    case 'False': emit(ctx, OP.LOADBOOL, dst, 0, 0); return;
    case 'Vararg': {
      emit(ctx, OP.VARARG, dst, 1, 0);
      return;
    }
    case 'Name': {
      const loc = ctx.findLocal(e.name);
      if (loc) {
        if (loc.box >= 0) emit(ctx, OP.BOXGET, dst, loc.box, 0);
        else emit(ctx, OP.MOVE, dst, loc.reg, 0);
      } else if (ctx.parent && tryUpval(ctx, e.name)) {
        emit(ctx, OP.GETUPVAL, dst, ctx.upvals.get(e.name), 0);
      } else {
        emit(ctx, OP.GETGLOBAL, dst, ctx.addK(e.name), 0);
      }
      return;
    }
    case 'Paren': {
      compileExprTrunc(ctx, e.e, dst);
      return;
    }
    case 'Index': {
      const objR = exprReg(ctx, e.obj);
      if (e.key.t === 'Str') {
        emit(ctx, OP.GETTABLEK, dst, objR, ctx.addK(e.key.v), 0);
      } else {
        const kr = exprReg(ctx, e.key);
        emit(ctx, OP.GETTABLE, dst, objR, kr);
      }
      return;
    }
    case 'Call': return compileCallExpr(ctx, e, dst, 1);
    case 'Func': {
      const child = new FnCtx(ctx, e.isVararg);
      if (e._macroLevel) child._macroLevel = e._macroLevel;
      compileFuncBody(child, e);
      ctx.protos.push(child);
      emit(ctx, OP.CLOSURE, dst, 0, 0);
      ctx.code[ctx.code.length - 1].pRef = child;
      return;
    }
    case 'Table': return compileTable(ctx, e, dst);
    case 'Un': {
      if (e.op === '-') {
        // constante negativa
        if (e.e.t === 'Num') { emit(ctx, OP.LOADK, dst, ctx.addK(-e.e.v), 0); return; }
      }
      const opn = e.op === 'not' ? OP.NOT : e.op === '-' ? OP.UNM : OP.LEN;
      emit(ctx, opn, dst, exprReg(ctx, e.e), 0);
      return;
    }
    case 'Bin': return compileBin(ctx, e, dst);
    default: throw new VantError('expresion no soportada: ' + e.t);
  }
}

// compila y trunca a un solo valor (para (f()) y posiciones de un valor)
function compileExprTrunc(ctx, e, dst) {
  if (e.t === 'Call') { compileCallExpr(ctx, e, dst, 1); return; }
  if (e.t === 'Vararg') { emit(ctx, OP.VARARG, dst, 1, 0); return; }
  compileExpr(ctx, e, dst);
}

// expresion en contexto que produce exactamente un valor
function compileExprSimple(ctx, e, dst) {
  compileExprTrunc(ctx, e, dst);
}

// registro que ya contiene el valor (local no encajonado) o un temp fresco
function exprReg(ctx, e) {
  if (e.t === 'Name') {
    const loc = ctx.findLocal(e.name);
    if (loc && loc.box < 0) return loc.reg;
  }
  const r = ctx.newReg();
  compileExprSimple(ctx, e, r);
  return r;
}

function compileBin(ctx, e, dst) {
  const op = e.op;
  if (op === 'and' || op === 'or') {
    compileExprSimple(ctx, e.l, dst);
    // and: truthy -> evaluar dst ; or: falsy -> evaluar dst
    // TEST a c: skip next si truthy(R[a]) ~= (c==1)  => c=0 salta si truthy, c=1 salta si falsy
    emit(ctx, OP.TEST, dst, op === 'and' ? 0 : 1, 0);
    const jOver = emitJump(ctx);
    compileExprSimple(ctx, e.r, dst);
    patchJump(ctx, jOver, ctx.code.length);
    return;
  }
  if (['==','~=','<','>','<=','>=','!='].includes(op)) {
    const kcmp = { '==': OP.EQK, '~=': OP.EQK, '<': OP.LTK, '<=': OP.LEK };
    if (e.r.t === 'Num' && op in kcmp) {
      emit(ctx, kcmp[op], exprReg(ctx, e.l), ctx.addK(e.r.v), op === '~=' ? 0 : 1);
      const jEnd = emitJump(ctx);
      emit(ctx, OP.LOADBOOL, dst, 0, 0);
      const jTrue = emitJump(ctx);
      patchJump(ctx, jEnd, ctx.code.length);
      emit(ctx, OP.LOADBOOL, dst, 1, 0);
      patchJump(ctx, jTrue, ctx.code.length);
      return;
    }
    const l = exprReg(ctx, e.l);
    const r = exprReg(ctx, e.r);
    const cmpOp = op === '!=' ? OP.EQ : op === '~=' ? OP.EQ : op === '==' ? OP.EQ : op === '<' ? OP.LT : op === '>' ? OP.LT : op === '<=' ? OP.LE : OP.LE;
    // para > y >= invertimos operandos
    const A = (op === '>' || op === '>=') ? r : l;
    const B = (op === '>' || op === '>=') ? l : r;
    // EQ/LT/LE a b c: skip next si (R[a] op R[b]) ~= (c==1); para ~= invertimos c
    let wantTrue = 1;
    if (op === '~=') wantTrue = 0;
    emit(ctx, cmpOp, A, B, wantTrue);
    const jEnd = emitJump(ctx);
    // falso: llega aqui cuando la comparacion NO se cumple (c=1) o SI (c=0 para ~=)
    emit(ctx, OP.LOADBOOL, dst, 0, 0);
    const jTrue = emitJump(ctx);
    patchJump(ctx, jEnd, ctx.code.length);
    emit(ctx, OP.LOADBOOL, dst, 1, 0);
    patchJump(ctx, jTrue, ctx.code.length);
    return;
  }
  if (op === '..') {
    // concatenacion: bloque contiguo para los operandos (los temps van arriba)
    const flat = flattenConcat(e);
    const base = ctx.freeReg;
    ctx.bump(base + flat.length);
    for (let i = 0; i < flat.length; i++) compileExprSimple(ctx, flat[i], base + i);
    emit(ctx, OP.CONCAT, dst, base, base + flat.length - 1);
    return;
  }
  const arithMap = { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '//': OP.DIV, '%': OP.MOD, '^': OP.POW, '&': OP.BAND, '|': OP.BOR, '~': OP.BXOR, '<<': OP.SHL, '>>': OP.SHR };
  if (arithMap[op]) {
    const kmap = { '+': OP.ADDK, '-': OP.SUBK, '*': OP.MULK, '/': OP.DIVK, '//': OP.DIVK, '%': OP.MODK, '^': OP.POWK };
    if (e.r.t === 'Num' && kmap[op]) {
      emit(ctx, kmap[op], dst, exprReg(ctx, e.l), ctx.addK(e.r.v));
      return;
    }
    if (e.l.t === 'Num' && (op === '+' || op === '*')) {
      emit(ctx, kmap[op], dst, exprReg(ctx, e.r), ctx.addK(e.l.v));
      return;
    }
    const l = exprReg(ctx, e.l);
    const r = exprReg(ctx, e.r);
    emit(ctx, arithMap[op], dst, l, r);
    return;
  }
  throw new VantError('operador no soportado: ' + op);
}

function flattenConcat(e) {
  if (e.t === 'Bin' && e.op === '..') return [...flattenConcat(e.l), ...flattenConcat(e.r)];
  return [e];
}

// ===================== llamadas, tablas y sentencias =====================

function compileCallExpr(ctx, e, dst, nres) {
  // los args DEBEN quedar contiguos despues del registro de la funcion:
  // se fuerza el bloque argBase..argBase+n-1 y los temporales van arriba
  let multi = false;
  if (e.method) {
    compileExprSimple(ctx, e.func, dst);
    emit(ctx, OP.SELF, dst, dst, ctx.addK(e.method));
    const argBase = dst + 2;
    ctx.bump(argBase + e.args.length);
    for (let i = 0; i < e.args.length; i++) {
      const a = e.args[i];
      const r = argBase + i;
      const last = i === e.args.length - 1;
      if (last && (a.t === 'Call' || a.t === 'Vararg')) { compileExprMulti(ctx, a, r); multi = true; }
      else compileExprSimple(ctx, a, r);
    }
    emit(ctx, OP.CALL, dst, multi ? 0 : e.args.length + 2, nres === 0 ? 0 : nres + 1);
    return;
  }
  compileExprSimple(ctx, e.func, dst);
  const argBase = dst + 1;
  ctx.bump(argBase + e.args.length);
  for (let i = 0; i < e.args.length; i++) {
    const a = e.args[i];
    const r = argBase + i;
    const last = i === e.args.length - 1;
    if (last && (a.t === 'Call' || a.t === 'Vararg')) { compileExprMulti(ctx, a, r); multi = true; }
    else compileExprSimple(ctx, a, r);
  }
  emit(ctx, OP.CALL, dst, multi ? 0 : e.args.length + 1, nres === 0 ? 0 : nres + 1);
}

// compila la lista de argumentos en regs consecutivos desde base; deja freeReg al final
function compileArgs(ctx, args, base) {
  ctx.freeReg = Math.max(ctx.freeReg, base);
  let multi = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const last = i === args.length - 1;
    const r = ctx.newReg();
    if (last && (a.t === 'Call' || a.t === 'Vararg')) {
      compileExprMulti(ctx, a, r);
      multi = true;
    } else {
      compileExprSimple(ctx, a, r);
    }
  }
  return { multi };
}

// expresion que puede devolver multiples valores, colocada a partir de r
function compileExprMulti(ctx, e, r) {
  if (e.t === 'Call') { compileCallExpr(ctx, e, r, 0); return; }
  if (e.t === 'Vararg') { emit(ctx, OP.VARARG, r, 0, 0); return; }
  compileExpr(ctx, e, r);
}

function compileTable(ctx, e, dst) {
  emit(ctx, OP.NEWTABLE, dst, 0, 0);
  const arr = [];
  const keyed = [];
  for (const en of e.entries) {
    if (!en.k) arr.push(en.v);
    else keyed.push(en);
  }
  // SETLIST por tandas de 50
  const B = 50;
  let idx = 0;
  while (idx < arr.length) {
    const batch = Math.min(B, arr.length - idx);
    const lastBatch = idx + batch >= arr.length;
    let multiLast = false;
    const base = dst + 1;
    ctx.bump(base + batch);
    for (let j = 0; j < batch; j++) {
      const item = arr[idx + j];
      if (lastBatch && j === batch - 1 && (item.t === 'Call' || item.t === 'Vararg')) { compileExprMulti(ctx, item, base + j); multiLast = true; }
      else compileExprSimple(ctx, item, base + j);
    }
    emit(ctx, OP.SETLIST, dst, multiLast ? 0 : batch, idx + 1);
    idx += batch;
  }
  ctx.bump(dst + 1);
  for (const en of keyed) {
    const kr = ctx.newReg();
    compileExprSimple(ctx, en.k, kr);
    const vr = ctx.newReg();
    compileExprSimple(ctx, en.v, vr);
    emit(ctx, OP.SETTABLE, dst, kr, vr);
  }
}

// ---------- referencias de asignacion ----------
// devuelve {kind:'local', loc} | {kind:'global', name} | {kind:'index', objReg, keyReg|kidx, isK}
function compileRef(ctx, e) {
  if (e.t === 'Name') {
    const loc = ctx.findLocal(e.name);
    if (loc) return { kind: 'local', loc };
    if (ctx.parent && tryUpval(ctx, e.name)) return { kind: 'upval', u: ctx.upvals.get(e.name) };
    return { kind: 'global', name: e.name };
  }
  if (e.t === 'Index') {
    const objR = ctx.newReg();
    compileExprSimple(ctx, e.obj, objR);
    if (e.key.t === 'Str') return { kind: 'index', objR, kidx: ctx.addK(e.key.v), isK: true };
    const keyR = ctx.newReg();
    compileExprSimple(ctx, e.key, keyR);
    return { kind: 'index', objR, keyR, isK: false };
  }
  throw new VantError('referencia invalida: ' + e.t);
}

function readRef(ctx, ref, dst) {
  if (ref.kind === 'local') {
    if (ref.loc.box >= 0) emit(ctx, OP.BOXGET, dst, ref.loc.box, 0);
    else emit(ctx, OP.MOVE, dst, ref.loc.reg, 0);
  } else if (ref.kind === 'upval') emit(ctx, OP.GETUPVAL, dst, ref.u, 0);
  else if (ref.kind === 'global') emit(ctx, OP.GETGLOBAL, dst, ctx.addK(ref.name), 0);
  else if (ref.kind === 'index') {
    if (ref.isK) emit(ctx, OP.GETTABLEK, dst, ref.objR, ref.kidx, 0);
    else emit(ctx, OP.GETTABLE, dst, ref.objR, ref.keyR, 0);
  }
}

function writeRef(ctx, ref, srcReg) {
  if (ref.kind === 'local') {
    if (ref.loc.box >= 0) emit(ctx, OP.BOXSET, ref.loc.box, srcReg, 0);
    else emit(ctx, OP.MOVE, ref.loc.reg, srcReg, 0);
  } else if (ref.kind === 'upval') emit(ctx, OP.SETUPVAL, ref.u, srcReg, 0);
  else if (ref.kind === 'global') emit(ctx, OP.SETGLOBAL, ctx.addK(ref.name), srcReg, 0);
  else if (ref.kind === 'index') {
    if (ref.isK) emit(ctx, OP.SETTABLEK, ref.objR, ref.kidx, srcReg);
    else emit(ctx, OP.SETTABLE, ref.objR, ref.keyR, srcReg);
  }
}

// compiles a block; endTargetInfo: {loopCtx} para break/continue
function compileBlock(ctx, stats, loop) {
  beginScope(ctx);
  for (const st of stats) compileStat(ctx, st, loop);
  endScope(ctx);
}

function compileFuncBody(child, e) {
  const cap = e._capNames || new Set();
  child.capturedNames = cap;
  child.params = e.params.slice();
  for (const p of e.params) {
    if (cap.has(p)) child.declareLocalBoxed(p);
    else child.declareLocal(p);
  }
  // prologo: si un param va en caja, BOXNEW lo saca de su reg (R[pi] ya trae el arg)
  for (const loc of child.locals) {
    if (loc.box >= 0) emit(child, OP.BOXNEW, loc.box, loc.reg, 0);
  }
  compileBlock(child, e.body, null);
  emit(child, OP.RETURN, 0, 1, 0);
  finishFrame(child);
}

function compileStat(ctx, st, loop) {
  const sc0 = ctx.scopes[ctx.scopes.length - 1];
  const floor = sc0 ? sc0.regBase : 0;
  compileStatInner(ctx, st, loop);
  let hi = floor;
  for (const l of ctx.locals) if (l.reg + 1 > hi) hi = l.reg + 1;
  ctx.freeReg = Math.max(ctx.freeReg, hi);
  if (ctx.freeReg > (ctx.maxReg || 0)) ctx.maxReg = ctx.freeReg;
}

function compileStatInner(ctx, st, loop) {
  switch (st.t) {
    case 'Local': {
      const n = st.names.length;
      const decls = [];
      for (const nm of st.names) {
        const d = (ctx.capturedNames && ctx.capturedNames.has(nm)) ? ctx.declareLocalBoxed(nm) : ctx.declareLocal(nm);
        decls.push(d);
      }
      // pre-nil de todos los targets (evita valores viejos cuando sobran)
      emit(ctx, OP.LOADNIL, decls[0].reg, n - 1, 0);
      for (const d of decls) if (d.box >= 0) emit(ctx, OP.BOXNEW, d.box, d.reg, 0);
      if (st.exprs.length === 0) {
        // nada mas
      } else {
        for (let i = 0; i < st.exprs.length; i++) {
          const ex = st.exprs[i];
          const target = i < n ? decls[i].reg : ctx.newReg();
          const last = i === st.exprs.length - 1;
          if (last && (ex.t === 'Call' || ex.t === 'Vararg')) {
            if (ex.t === 'Call') compileCallExpr(ctx, ex, target, i < n ? 0 : 1);
            else emit(ctx, OP.VARARG, target, i < n ? 0 : 1, 0);
          } else {
            compileExprSimple(ctx, ex, target);
          }
        }
        for (const d of decls) {
          if (d.box >= 0) emit(ctx, OP.BOXSET, d.box, d.reg, 0);
        }
      }
      break;
    }
    case 'LocalFunc': {
      const d = (ctx.capturedNames && ctx.capturedNames.has(st.name)) ? ctx.declareLocalBoxed(st.name) : ctx.declareLocal(st.name);
      if (d.box >= 0) {
        emit(ctx, OP.LOADNIL, d.reg, 0, 0);
        emit(ctx, OP.BOXNEW, d.box, d.reg, 0);
        compileExprSimple(ctx, st.fn, d.reg);
        emit(ctx, OP.BOXSET, d.box, d.reg, 0);
      } else {
        compileExprSimple(ctx, st.fn, d.reg);
      }
      break;
    }
    case 'ExprStat': {
      compileCallExpr(ctx, st.expr, ctx.newReg(), 0);
      break;
    }
    case 'Assign': {
      // 1) referencias
      const refs = st.targets.map(tg => compileRef(ctx, tg));
      // 1b) en sitio: un destino local simple y una expresion aritmetica/unaria
      //     se computan directo en el registro del destino (sin temp ni MOVE final)
      if (st.targets.length === 1 && st.exprs.length === 1 &&
          refs[0].kind === 'local' && refs[0].loc.box < 0 &&
          (st.exprs[0].t === 'Bin' || st.exprs[0].t === 'Un')) {
        compileExprSimple(ctx, st.exprs[0], refs[0].loc.reg);
        break;
      }
      // 2) RHS en regs frescos consecutivos
      const rhsBase = ctx.freeReg;
      const nT = st.targets.length;
      for (let i = 0; i < st.exprs.length; i++) {
        const ex = st.exprs[i];
        const r = rhsBase + i;
        ctx.bump(rhsBase + i + 1);
        const last = i === st.exprs.length - 1;
        if (last && (ex.t === 'Call' || ex.t === 'Vararg')) {
          if (ex.t === 'Call') compileCallExpr(ctx, ex, r, 0);
          else emit(ctx, OP.VARARG, r, 0, 0);
        } else compileExprSimple(ctx, ex, r);
      }
      // 3) asignar; sobrantes a nil
      for (let i = 0; i < nT; i++) {
        const src = rhsBase + i;
        if (i >= st.exprs.length) {
          const t = ctx.newReg(); emit(ctx, OP.LOADNIL, t, 0, 0);
          writeRef(ctx, refs[i], t);
        } else writeRef(ctx, refs[i], src);
      }
      break;
    }
    case 'CompAssign': {
      const ref = compileRef(ctx, st.target);
      // valor actual
      const cur = ctx.newReg();
      readRef(ctx, ref, cur);
      // valor nuevo
      const val = ctx.newReg();
      compileExprSimple(ctx, st.expr, val);
      const map = { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '//': OP.DIV, '%': OP.MOD, '^': OP.POW, '..': OP.CONCAT };
      if (st.op === '..') {
        emit(ctx, OP.CONCAT, cur, cur, val);
      } else if (st.op in map) {
        emit(ctx, map[st.op], cur, cur, val);
      } else throw new VantError('operador compuesto no soportado: ' + st.op);
      writeRef(ctx, ref, cur);
      break;
    }
    case 'If': {
      const endJumps = [];
      for (let i = 0; i < st.clauses.length; i++) {
        const cl = st.clauses[i];
        const t = ctx.newReg();
        compileExprSimple(ctx, cl.cond, t);
        emit(ctx, OP.TEST, t, 0, 0); // truthy: salta el JMP siguiente
        const jElse = emitJump(ctx);
        compileBlock(ctx, cl.body, loop);
        if (i < st.clauses.length - 1 || st.orelse) endJumps.push(emitJump(ctx));
        patchJump(ctx, jElse, ctx.code.length);
      }
      if (st.orelse) compileBlock(ctx, st.orelse, loop);
      patchList(ctx, endJumps, ctx.code.length);
      break;
    }
    case 'While': {
      const condPc = ctx.code.length;
      const t = ctx.newReg();
      compileExprSimple(ctx, st.cond, t);
      emit(ctx, OP.TEST, t, 0, 0);
      const jEnd = emitJump(ctx);
      const sub = { breaks: [], continues: [], loopContinue: condPc };
      compileBlock(ctx, st.body, sub);
      emit(ctx, OP.JMP, 0, condPc - ctx.code.length, 0);
      const endPc = ctx.code.length;
      patchJump(ctx, jEnd, endPc);
      patchList(ctx, sub.breaks, endPc);
      break;
    }
    case 'Repeat': {
      // cuerpo y cond comparten ambito de locales (semantica Lua)
      beginScope(ctx);
      const bodyPc = ctx.code.length;
      const sub = { breaks: [], continues: [], deferredContinue: true };
      for (const s2 of st.body) compileStat(ctx, s2, sub);
      // cond ve los locales del cuerpo
      const condPc = ctx.code.length;
      const t = ctx.newReg();
      compileExprSimple(ctx, st.cond, t);
      emit(ctx, OP.TEST, t, 0, 0); // truthy: salta el JMP (sale del bucle)
      const jLoop = emitJump(ctx);
      patchJump(ctx, jLoop, bodyPc);
      patchList(ctx, sub.continues, condPc);
      const endPc = ctx.code.length;
      patchList(ctx, sub.breaks, endPc);
      ctx.locals.length = ctx.scopes[ctx.scopes.length - 1].base;
      ctx.freeReg = ctx.scopes[ctx.scopes.length - 1].regBase;
      ctx.scopes.pop();
      break;
    }
    case 'NumFor': {
      const rFrom = ctx.newReg();
      compileExprSimple(ctx, st.from, rFrom);
      const rTo = ctx.newReg();
      compileExprSimple(ctx, st.to, rTo);
      const rStep = ctx.newReg();
      if (st.step) compileExprSimple(ctx, st.step, rStep);
      else emit(ctx, OP.LOADK, rStep, ctx.addK(1), 0);
      const rVar = ctx.newReg();
      beginScope(ctx);
      emit(ctx, OP.FORPREP, rFrom, 0, 0);
      const prepIdx = ctx.code.length - 1;
      const bodyPc = ctx.code.length;
      const cap = ctx.capturedNames && ctx.capturedNames.has(st.name);
      if (cap) {
        const box = ctx.nboxes++;
        emit(ctx, OP.BOXNEW, box, rVar, 0);
        ctx.locals.push({ name: st.name, reg: rVar, box, from: 'for' });
      } else {
        ctx.locals.push({ name: st.name, reg: rVar, box: -1, from: 'for' });
      }
      const sub = { breaks: [], continues: [], deferredContinue: true };
      for (const s2 of st.body) compileStat(ctx, s2, sub);
      ctx.locals.length = ctx.locals.length - 1;
      const flPc = ctx.code.length;
      emit(ctx, OP.FORLOOP, rFrom, bodyPc - (flPc + 1), 0);
      patchJump(ctx, prepIdx, flPc);
      patchList(ctx, sub.continues, flPc);
      const endPc = ctx.code.length;
      patchList(ctx, sub.breaks, endPc);
      endScope(ctx);
      break;
    }
    case 'GenFor': {
      const n = st.names.length;
      const rF = ctx.newReg();
      ctx.bump(rF + 3);
      // f, s, ctrl: ajustar explist a exactamente 3 valores
      const ne = st.exprs.length;
      for (let i = 0; i < ne && i < 3; i++) {
        const ex = st.exprs[i];
        const last = i === ne - 1;
        if (last && ex.t === 'Call') {
          compileCallExpr(ctx, ex, rF + i, Math.max(1, 3 - i));
        } else if (last && ex.t === 'Vararg') {
          emit(ctx, OP.VARARG, rF + i, Math.max(1, 3 - i), 0);
        } else {
          compileExprSimple(ctx, ex, rF + i);
        }
      }
      // rellenar huecos de f/s/ctrl (solo si el ultimo no es multi)
      const lastE = ne > 0 ? st.exprs[ne - 1] : null;
      const lastMulti = lastE && (lastE.t === 'Call' || lastE.t === 'Vararg');
      if (ne === 0) emit(ctx, OP.LOADNIL, rF, 2, 0);
      else if (!lastMulti && ne < 3) emit(ctx, OP.LOADNIL, rF + ne, 2 - ne, 0);
      // vars visibles
      beginScope(ctx);
      emit(ctx, OP.LOADNIL, rF + 3, n - 1, 0);
      const decls = [];
      for (const nm of st.names) {
        if (ctx.capturedNames && ctx.capturedNames.has(nm)) {
          const box = ctx.nboxes++;
          decls.push({ name: nm, reg: rF + 2 + decls.length, box, from: 'genfor' });
        } else {
          decls.push({ name: nm, reg: rF + 2 + decls.length, box: -1, from: 'genfor' });
        }
      }
      for (const d of decls) ctx.locals.push(d);
      const tcallPc = ctx.code.length;
      emit(ctx, OP.TFORCALL, rF, n, 0);
      const tloopIdx = ctx.code.length;
      emit(ctx, OP.TFORLOOP, rF, 0, 0);
      const jEnd = emitJump(ctx); // cae aqui cuando el iterador se agota
      const bodyPc = ctx.code.length;
      ctx.code[tloopIdx].b = bodyPc - (tloopIdx + 1);
      for (const d of decls) if (d.box >= 0) emit(ctx, OP.BOXNEW, d.box, d.reg, 0);
      const sub = { breaks: [], continues: [], deferredContinue: true };
      for (const s2 of st.body) compileStat(ctx, s2, sub);
      ctx.locals.length = ctx.locals.length - n;
      const jBack = emitJump(ctx);
      patchJump(ctx, jBack, tcallPc);
      const endPc = ctx.code.length;
      patchJump(ctx, jEnd, endPc);
      patchList(ctx, sub.continues, tcallPc);
      patchList(ctx, sub.breaks, endPc);
      endScope(ctx);
      break;
    }
    case 'Do': {
      compileBlock(ctx, st.body, loop);
      break;
    }
    case 'Break': {
      if (!loop) throw new VantError('break fuera de bucle');
      loop.breaks.push(emitJump(ctx));
      break;
    }
    case 'Continue': {
      if (!loop) throw new VantError('continue fuera de bucle');
      if (loop.deferredContinue) loop.continues.push(emitJump(ctx));
      else emit(ctx, OP.JMP, 0, loop.loopContinue - (ctx.code.length + 1), 0);
      break;
    }
    case 'Return': {
      const n = st.exprs.length;
      if (n === 0) { emit(ctx, OP.RETURN, 0, 1, 0); break; }
      const base = ctx.newReg();
      for (let i = 0; i < n; i++) {
        const ex = st.exprs[i];
        const r = base + i;
        ctx.bump(base + i + 1);
        const last = i === n - 1;
        if (last && (ex.t === 'Call' || ex.t === 'Vararg')) {
          if (ex.t === 'Call') compileCallExpr(ctx, ex, r, 0);
          else emit(ctx, OP.VARARG, r, 0, 0);
          emit(ctx, OP.RETURN, base, 0, 0);
        } else {
          compileExprSimple(ctx, ex, r);
          if (last) emit(ctx, OP.RETURN, base, n + 1, 0);
        }
      }
      break;
    }
    case 'FuncStat': {
      const { parts, method } = st.target;
      const key = method || parts[parts.length - 1];
      const chain = method ? parts : parts.slice(0, -1);
      const r = ctx.newReg();
      if (chain.length === 0) {
        const loc = ctx.findLocal(key);
        compileExprSimple(ctx, st.fn, r);
        if (loc) {
          if (loc.box >= 0) emit(ctx, OP.BOXSET, loc.box, r, 0);
          else emit(ctx, OP.MOVE, loc.reg, r, 0);
        } else {
          emit(ctx, OP.SETGLOBAL, ctx.addK(key), r, 0);
        }
      } else {
        const first = chain[0];
        const loc = ctx.findLocal(first);
        let objReg = ctx.newReg();
        if (loc) {
          if (loc.box >= 0) emit(ctx, OP.BOXGET, objReg, loc.box, 0);
          else emit(ctx, OP.MOVE, objReg, loc.reg, 0);
        } else {
          emit(ctx, OP.GETGLOBAL, objReg, ctx.addK(first), 0);
        }
        for (let i = 1; i < chain.length; i++) {
          const nr = ctx.newReg();
          emit(ctx, OP.GETTABLEK, nr, objReg, ctx.addK(chain[i]), 0);
          objReg = nr;
        }
        compileExprSimple(ctx, st.fn, r);
        emit(ctx, OP.SETTABLEK, objReg, ctx.addK(key), r);
      }
      break;
    }
    default:
      throw new VantError('sentencia no soportada: ' + st.t);
  }
}

// ===================== serializacion del bytecode =====================
// Formato: bytes con varints LEB128. Numeros constantes como cadenas decimales (exactos en doubles).
class ByteWriter {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 255); }
  uv(v) {
    v = Math.floor(v);
    if (v < 0) throw new VantError('varint negativo');
    while (true) {
      if (v < 128) { this.bytes.push(v); return; }
      this.bytes.push((v % 128) + 128);
      v = Math.floor(v / 128);
    }
  }
  sv(v) { // zigzag
    if (v >= 0) this.uv(v * 2);
    else this.uv(-v * 2 - 1);
  }
  str(s) {
    const len = s.length;
    this.uv(len);
    for (let i = 0; i < len; i++) this.bytes.push(s.charCodeAt(i) & 255);
  }
  toStr() { return this.bytes.map(b => String.fromCharCode(b)).join(''); }
}

function serializeProto(w, fn, ops, opts = {}) {
  w.u8(fn.isVararg ? 1 : 0);
  w.uv(fn.params ? fn.params.length : 0);
  w.uv(fn.nr);
  w.uv(fn.nboxes);
  w.uv(fn.upvalList.length);
  for (const u of fn.upvalList) { w.u8(u.kind); w.uv(u.idx); }
  const cf = constFlag(fn, opts);
  w.u8(cf);
  w.uv(fn.k.length);
  for (let ki = 0; ki < fn.k.length; ki++) {
    const kv = fn.k[ki];
    if (typeof kv === 'number') { w.u8(1); w.str(cf & 2 ? encConst(fmtNum(kv), opts.seed, fn.pid, ki + 1) : fmtNum(kv)); }
    else if (typeof kv === 'string') { w.u8(2); w.str(cf & 1 ? encConst(kv, opts.seed, fn.pid, ki + 1) : kv); }
    else if (typeof kv === 'boolean') { w.u8(3); w.u8(kv ? 1 : 0); }
    else { w.u8(0); }
  }
  const JUMPS = new Set([OP.JMP, OP.FORPREP, OP.FORLOOP, OP.TFORLOOP]);
  w.uv(fn.code.length);
  for (const ins of fn.code) {
    w.uv(ops[ins.o]);
    w.uv(ins.a || 0);
    if (JUMPS.has(ins.o)) w.sv(ins.b === undefined ? 0 : ins.b);
    else w.uv(ins.b === undefined ? 0 : ins.b);
    w.uv(ins.c === undefined ? 0 : ins.c);
  }
  // saltos: b puede ser negativo -> usar sv en ops de salto
  // re-escribimos: guardamos con sv para ops de salto
  w.uv(fn.protos.length);
  for (const c of fn.protos) serializeProto(w, c, ops, opts);
}

// Nivel de cifrado de constantes por proto (version 2 del formato):
//   bit 1 = strings cifradas, bit 2 = numeros cifrados. 0 = plain (macros de rendimiento)
const LEVEL_FLAG = { bajo: 3, medio: 2, alto: 0, extremo: 0 };

function constFlag(fn, opts) {
  if (fn._macroLevel && LEVEL_FLAG[fn._macroLevel] !== undefined) return LEVEL_FLAG[fn._macroLevel];
  return opts.constFlag || 0;
}

// Misma aritmetica que _de en el runtime: keystream por (seed, pid, idx)
function encConst(str, seed, pid, idx) {
  let k0 = (seed + pid * 1000003 + idx * 31) % 2147483647;
  if (k0 <= 0) k0 += 2147483646;
  let out = '';
  for (let j = 0; j < str.length; j++) {
    k0 = (k0 * 16807) % 2147483647;
    out += String.fromCharCode((str.charCodeAt(j) & 255) ^ (k0 % 256));
  }
  return out;
}

export function serializeRoot(fn, ops, opts = {}) {
  const w = new ByteWriter();
  w.u8(2); // version 2: byte de flag de constantes por proto
  serializeProto(w, fn, ops, opts);
  return w.toStr();
}

function fmtNum(v) {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return String(v);
  if (v === Infinity) return '1e999';
  if (v === -Infinity) return '-1e999';
  if (Number.isNaN(v)) return '(0/0)';
  return String(v);
}

// ===================== orden de opcodes aleatorio por semilla =====================
export function shuffledOps(seed, shuffle = true) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rnd = () => { s = s * 16807 % 2147483647; return s / 2147483647; };
  const arr = OP_NAMES.map((_, i) => i);
  if (!shuffle) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr; // arr[nombreIdx] = opcode real
}

// ===================== runtime Lua =====================
function nibbleTableLiteral() {
  const t = [];
  for (let i = 0; i < 256; i++) t.push((i >> 4) ^ (i & 15));
  return t.join(',');
}

function blobChunks(data) {
  // data: cadena de chars 0..255 -> string.char(...) en tandas
  const parts = [];
  const B = 200;
  for (let i = 0; i < data.length; i += B) {
    const chunk = [];
    for (let j = i; j < Math.min(i + B, data.length); j++) chunk.push(data.charCodeAt(j));
    parts.push('string.char(' + chunk.join(',') + ')');
  }
  if (!parts.length) return "''";
  return 'table.concat({' + parts.join(',') + '})';
}

// PM: la misma aritmetica del runtime (exacta en doubles)
function keystreamBytes(seed, n) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    out[i] = s % 256;
  }
  return out;
}

export function emitRuntime(data, seed, ops, opts = {}) {
  // ops: array nombreIdx -> opcode real
  const O = {};
  OP_NAMES.forEach((n, i) => { O[n] = ops[i]; });
  const layers = opts.layers === 2 ? 2 : 1;
  const ks = keystreamBytes(seed, data.length);
  let enc = '';
  for (let i = 0; i < data.length; i++) {
    const b = data.charCodeAt(i) & 255;
    enc += String.fromCharCode(b ^ ks[i]);
  }
  const seed2 = (seed * 7919) % 2147483647 || 1;
  if (layers === 2) {
    const ks2 = keystreamBytes(seed2, data.length);
    let enc2 = '';
    for (let i = 0; i < enc.length; i++) enc2 += String.fromCharCode(enc.charCodeAt(i) ^ ks2[i]);
    enc = enc2;
  }
  const lua = `
local _NX = {${nibbleTableLiteral()}}
local function _x(a, b)
  return _NX[(a - a % 16) / 16 * 16 + (b - b % 16) / 16 + 1] * 16 + _NX[a % 16 * 16 + b % 16 + 1]
end
local b32 = bit32
local function _band(x, y)
  if b32 then return b32.band(x, y) end
  local r, bv = 0, 1
  x = x % 4294967296; y = y % 4294967296
  for i = 1, 32 do
    local xb, yb = x % 2, y % 2
    if xb == 1 and yb == 1 then r = r + bv end
    x = (x - xb) / 2; y = (y - yb) / 2; bv = bv * 2
  end
  return r
end
local function _bor(x, y)
  if b32 then return b32.bor(x, y) end
  local r, bv = 0, 1
  x = x % 4294967296; y = y % 4294967296
  for i = 1, 32 do
    local xb, yb = x % 2, y % 2
    if xb == 1 or yb == 1 then r = r + bv end
    x = (x - xb) / 2; y = (y - yb) / 2; bv = bv * 2
  end
  return r
end
local function _bxor(x, y)
  if b32 then return b32.bxor(x, y) end
  local r, bv = 0, 1
  x = x % 4294967296; y = y % 4294967296
  for i = 1, 32 do
    local xb, yb = x % 2, y % 2
    if xb ~= yb then r = r + bv end
    x = (x - xb) / 2; y = (y - yb) / 2; bv = bv * 2
  end
  return r
end
local function _shl(x, n)
  if b32 then return b32.lshift(x, n) end
  if n <= 0 then return x % 4294967296 end
  if n >= 32 then return 0 end
  return (x % 4294967296) * 2 ^ n % 4294967296
end
local function _shr(x, n)
  if b32 then return b32.rshift(x, n) end
  if n <= 0 then return x % 4294967296 end
  if n >= 32 then return 0 end
  return math.floor((x % 4294967296) / 2 ^ n)
end
${opts.junk ? `local _j1 = 0
do
  local _j2 = 7
  for _i = 1, 6 do _j2 = (_j2 * 31 + _i) % 2147483647 end
  if _j2 == 999999 then _j1 = _j2 end
end
` : ''}local _S0 = ${seed % 2147483647}
if _S0 <= 0 then _S0 = _S0 + 2147483646 end
local _S1 = ${seed2}
if _S1 <= 0 then _S1 = _S1 + 2147483646 end
local _S = _S0
local _blob = ${blobChunks(enc)}
for _pass = 1, ${layers} do
  local parts = {}
  _S = _pass == 1 and _S0 or _S1
  for i = 1, #_blob do
    _S = _S * 16807 % 2147483647
    parts[i] = string.char(_x(string.byte(_blob, i), _S % 256))
  end
  _blob = table.concat(parts)
end
local _pos = 1
local function _u8() local v = string.byte(_blob, _pos); _pos = _pos + 1; return v end
local function _uv()
  local v, m = 0, 1
  while true do
    local b = string.byte(_blob, _pos); _pos = _pos + 1
    v = v + (b % 128) * m
    if b < 128 then break end
    m = m * 128
  end
  return v
end
local function _sv()
  local v = _uv()
  local neg = v % 2
  v = (v - neg) / 2
  if neg == 1 then return -v - 1 end
  return v
end
local function _str()
  local len = _uv()
  local s = string.sub(_blob, _pos, _pos + len - 1)
  _pos = _pos + len
  return s
end
local _ver, _cf = 0, 0
local function _de(s, pid, idx)
  local k0 = (${seed % 2147483647} + pid * 1000003 + idx * 31) % 2147483647
  if k0 <= 0 then k0 = k0 + 2147483646 end
  local out, kk = {}, k0
  for j = 1, #s do
    kk = kk * 16807 % 2147483647
    out[j] = string.char(_bxor(string.byte(s, j), kk % 256))
  end
  return table.concat(out)
end
local function _k(pid, idx)
  local tag = _u8()
  if tag == 1 then
    local s = _str()
    if _band(_cf, 2) ~= 0 then s = _de(s, pid, idx) end
    return tonumber(s)
  end
  if tag == 2 then
    local s = _str()
    if _band(_cf, 1) ~= 0 then s = _de(s, pid, idx) end
    return s
  end
  if tag == 3 then return _u8() == 1 end
  return nil
end
local _P = {}
_ver = _u8() -- version
local function _proto()
  local P = {}
  local id = #_P + 1
  _P[id] = P
  P.nv = _u8()
  P.np = _uv()
  P.nr = _uv()
  P.nb = _uv()
  local nu = _uv()
  P.u = {}
  for i = 1, nu do
    P.u[i] = { _u8(), _uv() }
  end
  if _ver >= 2 then _cf = _u8() else _cf = 0 end
  local nk = _uv()
  P.k = {}
  for i = 1, nk do P.k[i] = _k(id, i) end
  local nc = _uv()
  P.co = {}
  P.ca = {}
  P.cb = {}
  P.cc = {}
  for i = 1, nc do
    local o = _u8()
    local a = _uv()
    local b = _uv()
    local c = _uv()
    if o == ${O.JMP} or o == ${O.FORPREP} or o == ${O.FORLOOP} or o == ${O.TFORLOOP} then
      b = i + 1 + ((b - b % 2) / 2 * (b % 2 == 1 and -1 or 1) - (b % 2 == 1 and 1 or 0))
    end
    P.co[i] = o; P.ca[i] = a; P.cb[i] = b; P.cc[i] = c
  end
  local np2 = _uv()
  P.p = {}
  for i = 1, np2 do P.p[i] = _proto() end
  return P
end
_proto()
local _pack = table.pack or function(...) local t = {...}; t.n = select('#', ...); return t end
local _unpack = unpack or table.unpack
local function _run(pi, ups, ...)
  local P = _P[pi]
  local R = {}
  local B = {}
  local args = _pack(...)
  local va = {}
  local n = args.n or #args
  for i = 1, P.np do R[i - 1] = args[i] end
  if P.nv == 1 then
    for i = P.np + 1, n do va[i - P.np] = args[i] end
    va.n = n - P.np
    if va.n < 0 then va.n = 0 end
  end
  local top = P.nr - 1
  local pc = 1
  local CO = P.co
  local CA = P.ca
  local CB = P.cb
  local CC = P.cc
  local K = P.k
  while true do
    local o = CO[pc]
    local a = CA[pc]
    local b = CB[pc]
    local c = CC[pc]
    pc = pc + 1
    if o == ${O.MOVE} then
      R[a] = R[b]
    elseif o == ${O.GETTABLEK} then
      R[a] = R[b][K[c + 1]]
    elseif o == ${O.GETTABLE} then
      R[a] = R[b][R[c]]
    elseif o == ${O.CALL} then
      local f = R[a]
      local res
      if b == 0 then res = _pack(f(_unpack(R, a + 1, top)))
      else res = _pack(f(_unpack(R, a + 1, a + b - 1))) end
      local m = res.n or #res
      if c == 0 then
        for i = 1, m do R[a + i - 1] = res[i] end
        top = a + m - 1
      else
        for i = 1, c - 1 do R[a + i - 1] = res[i] end
      end
    elseif o == ${O.ADD} then R[a] = R[b] + R[c]
    elseif o == ${O.LOADK} then
      R[a] = K[b + 1]
    elseif o == ${O.JMP} then
      pc = b
    elseif o == ${O.FORLOOP} then
      R[a] = R[a] + R[a + 2]
      local go
      if R[a + 2] > 0 then go = R[a] <= R[a + 1] else go = R[a] >= R[a + 1] end
      if go then R[a + 3] = R[a]; pc = b end
    elseif o == ${O.FORPREP} then
      local st = R[a + 2]
      if st == 0 then error("'for' step is zero", 0) end
      R[a] = R[a] - st
      pc = b
    elseif o == ${O.ADDK} then R[a] = R[b] + K[c + 1]
    elseif o == ${O.MODK} then R[a] = R[b] % K[c + 1]
    elseif o == ${O.MULK} then R[a] = R[b] * K[c + 1]
    elseif o == ${O.SUBK} then R[a] = R[b] - K[c + 1]
    elseif o == ${O.DIVK} then R[a] = R[b] / K[c + 1]
    elseif o == ${O.POWK} then R[a] = R[b] ^ K[c + 1]
    elseif o == ${O.EQK} then
      if (R[a] == K[b + 1]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.LTK} then
      if (R[a] < K[b + 1]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.LEK} then
      if (R[a] <= K[b + 1]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.MUL} then R[a] = R[b] * R[c]
    elseif o == ${O.SUB} then R[a] = R[b] - R[c]
    elseif o == ${O.DIV} then R[a] = R[b] / R[c]
    elseif o == ${O.MOD} then R[a] = R[b] % R[c]
    elseif o == ${O.POW} then R[a] = R[b] ^ R[c]
    elseif o == ${O.EQ} then
      if (R[a] == R[b]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.LT} then
      if (R[a] < R[b]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.LE} then
      if (R[a] <= R[b]) ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.TEST} then
      local v = R[a]
      local tv = not (not v)
      if tv ~= (c == 1) then pc = pc + 1 end
    elseif o == ${O.SELF} then
      R[a + 1] = R[b]
      R[a] = R[b][K[c + 1]]
    elseif o == ${O.SETTABLEK} then
      R[a][K[b + 1]] = R[c]
    elseif o == ${O.SETTABLE} then
      R[a][R[b]] = R[c]
    elseif o == ${O.CONCAT} then
      local s = R[b]
      for i = b + 1, c do s = s .. R[i] end
      R[a] = s
    elseif o == ${O.GETGLOBAL} then
      R[a] = _G[K[b + 1]]
    elseif o == ${O.RETURN} then
      if b == 0 then return _unpack(R, a, top)
      elseif b == 1 then return
      else return _unpack(R, a, a + b - 2) end
    elseif o == ${O.TFORCALL} then
      local res = _pack(R[a](R[a + 1], R[a + 2]))
      local m = res.n or #res
      for i = 1, b do R[a + 1 + i] = res[i] end
    elseif o == ${O.TFORLOOP} then
      if R[a + 2] ~= nil then pc = b end
    elseif o == ${O.LOADBOOL} then
      R[a] = (b == 1)
    elseif o == ${O.LOADNIL} then
      for i = a, a + b do R[i] = nil end
    elseif o == ${O.NOT} then R[a] = not R[b]
    elseif o == ${O.LEN} then R[a] = #R[b]
    elseif o == ${O.UNM} then R[a] = -R[b]
    elseif o == ${O.VARARG} then
      if b == 0 then
        local m = va.n or #va
        for i = 1, m do R[a + i - 1] = va[i] end
        top = a + m - 1
      else
        for i = 1, b do R[a + i - 1] = va[i] end
      end
    elseif o == ${O.NEWTABLE} then
      R[a] = {}
    elseif o == ${O.SETLIST} then
      if b == 0 then b = top - a end
      for i = 1, b do R[a][c + i - 1] = R[a + i] end
    elseif o == ${O.CLOSURE} then
      local cp = _P[b]
      local cu = {}
      for i = 1, cp.u and #cp.u or 0 do
        local d = cp.u[i]
        if d[1] == 1 then cu[i] = B[d[2]] else cu[i] = ups[d[2] + 1] end
      end
      R[a] = function(...) return _run(b, cu, ...) end
    elseif o == ${O.GETUPVAL} then
      R[a] = ups[b + 1][1]
    elseif o == ${O.SETUPVAL} then
      ups[b + 1][1] = R[a]
    elseif o == ${O.SETGLOBAL} then
      _G[K[b + 1]] = R[a]
    elseif o == ${O.BOXNEW} then
      B[a] = { R[b] }
    elseif o == ${O.BOXGET} then
      R[a] = B[b][1]
    elseif o == ${O.BOXSET} then
      B[a][1] = R[b]
    elseif o == ${O.BAND} then R[a] = _band(R[b], R[c])
    elseif o == ${O.BOR} then R[a] = _bor(R[b], R[c])
    elseif o == ${O.BXOR} then R[a] = _bxor(R[b], R[c])
    elseif o == ${O.SHL} then R[a] = _shl(R[b], R[c])
    elseif o == ${O.SHR} then R[a] = _shr(R[b], R[c])
    else
      error("vantobf: opcode desconocido " .. tostring(o), 0)
    end  end
end
${opts.antiEnv !== false ? `do
  local _ae_stop = false
  local function _ae() _ae_stop = true end
  -- Checks de consistencia del entorno de Roblox (Luau). Senales ligeras:
  -- una API faltante o restringida se salta, no cuenta como fallo.
  pcall(function()
    local _ok, _pl = pcall(function() return game:GetService("Players") end)
    if _ok and _pl and _pl.GetPlayerFromCharacter and _pl.GetPlayerFromCharacter(_pl, workspace) ~= nil then _ae() end
  end)
  pcall(function()
    local _ok, _gs = pcall(function() return game:GetService("GuiService") end)
    if _ok and _gs then
      local _prev = _gs.SelectedObject
      local _ok2, _part = pcall(function() return Instance.new("Part") end)
      if _ok2 and _part then
        local _acc = pcall(function() _gs.SelectedObject = _part end)
        if _acc then
          _ae()
          pcall(function() _gs.SelectedObject = _prev end)
        end
        pcall(function() _part:Destroy() end)
      end
    end
  end)
  pcall(function()
    local _ok, _ts = pcall(function() return game:GetService("TweenService") end)
    if _ok and _ts then
      local _ok2, _part = pcall(function() return Instance.new("Part") end)
      if _ok2 and _part then
        local _ok3, _inf = pcall(function() return TweenInfo.new(0.1) end)
        if _ok3 and _inf then
          local _ok4, _gt = pcall(function() return _ts:Create(_part, _inf, { Transparency = 1 }) end)
          if _ok4 and _gt then
            pcall(function() _gt:Destroy() end)
            local _bad = { Position = "not a Vector3", CFrame = true, Transparency = "not a number" }
            for _bk, _bv in pairs(_bad) do
              local _ok5, _bt = pcall(function() return _ts:Create(_part, _inf, { [_bk] = _bv }) end)
              if _ok5 then
                _ae()
                if _bt then pcall(function() _bt:Destroy() end) end
              end
            end
          end
        end
        pcall(function() _part:Destroy() end)
      end
    end
  end)
  pcall(function()
    local _ok, _f = pcall(function() return Instance.new("Folder") end)
    if _ok and _f then
      local _ok2, _c = pcall(function() return Instance.new("Folder") end)
      if _ok2 and _c then
        _c.Name = "AEPC"
        _c.Parent = _f
        if _f:FindFirstChild("AEPC") ~= _c or _c.Parent ~= _f or _c:IsA("Folder") ~= true then _ae() end
        local _ok3, _cl = pcall(function() return _f:Clone() end)
        if _ok3 then
          if not _cl then _ae() else
            local _cc = _cl:FindFirstChild("AEPC")
            if _cl == _f or not _cc or _cc == _c or _cc.Parent ~= _cl then _ae() end
          end
          pcall(function() _cl:Destroy() end)
        end
        pcall(function() _c:Destroy() end)
      end
      pcall(function() _f:Destroy() end)
    end
  end)
  pcall(function()
    local _a = Vector3.new(2, -3, 4)
    local _b = Vector3.new(-1, 5, 2)
    if (_a + _b).X ~= 1 or (_a - _b).Z ~= 2 or _a:Dot(_b) ~= -9 then _ae() end
  end)
  pcall(function()
    if typeof(Vector3.new(1, 1, 1)) ~= "Vector3" then _ae() end
  end)
  pcall(function()
    local _ok, _p2 = pcall(function() return Instance.new("Part") end)
    if _ok and _p2 then
      if _p2.ClassName ~= "Part" or _p2:IsA("BasePart") ~= true then _ae() end
      pcall(function() _p2:Destroy() end)
    end
  end)
  if _ae_stop then
    return
  end
end
` : ''}
${opts.guard ? `do
  local _exp = string.char(${[...(opts.guard)].map(c => (c.charCodeAt(0) - 41) + '+41').join(',')})
  local _v
  pcall(function() if type(getgenv) == "function" then _v = rawget(getgenv(), "VANTA" .. "RMOR_RUN") end end)
  if _v ~= _exp then pcall(function() _v = rawget(_G, "VANTA" .. "RMOR_RUN") end) end
  if _v ~= _exp then
    pcall(function()
      local Players = game:GetService("Players")
      local lp = Players.LocalPlayer
      if not lp and Players.GetPlayers then local _l = Players:GetPlayers(); lp = _l[1] end
      if lp and lp.Kick then lp:Kick("Obfuscated script, don't deobfuscate") end
    end)
    return
  end
end
` : ''}return _run(1, {}, ...)
`;
  if (opts.mangle) {
    const sfx = String(seed % 9973);
    const names = ['_NX','_x','_S0','_S','_blob','_pos','_u8','_uv','_sv','_str','_de','_k','_P','_proto','_pack','_unpack','_band','_bor','_bxor','_shl','_shr','_run','_cf','_ver','_pass','_j1','_j2','_i','_exp','_v','b32'];
    let out = lua;
    for (const n of names) out = out.replace(new RegExp('\\b' + n + '\\b', 'g'), n + sfx);
    return out;
  }
  return lua;
}
