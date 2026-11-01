// Codificador y ejecutor de bytecode. El codificador asigna a cada operación un número
// distinto según una semilla, así que cada script tiene su propia tabla de opcodes.
// Esta VM de referencia en TypeScript define la semántica que replicará el runtime en Lua.
import { OP_NAMES } from "./compiler.js";
export class RuntimeError extends Error {
}
export class LuaTable {
    hash = new Map();
    metatable = null;
}
// Metamétodo de `t`, o null si no tiene metatabla o no lo define.
function metamethod(t, name) {
    if (!(t instanceof LuaTable) || !t.metatable)
        return null;
    const v = t.metatable.hash.get(name);
    return v === undefined ? null : v;
}
export class LuaFunction {
    proto;
    upvals;
    constructor(proto, upvals) {
        this.proto = proto;
        this.upvals = upvals;
    }
}
const DEFAULT_MAX_STEPS = 1_000_000;
const MAX_DEPTH = 1000;
// Generador pseudoaleatorio determinista (mulberry32): la misma semilla da el mismo mapa.
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function encode(program, seed) {
    const rand = prng(seed);
    const opTable = [...OP_NAMES];
    for (let i = opTable.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [opTable[i], opTable[j]] = [opTable[j], opTable[i]];
    }
    const idOf = new Map(opTable.map((name, id) => [name, id]));
    const protos = program.protos.map((p) => {
        const code = [];
        for (const instr of p.code) {
            code.push(idOf.get(instr.op), instr.a ?? 0);
        }
        return { code, params: p.params, slots: p.slots, upvals: p.upvals, boxedParams: p.boxedParams };
    });
    return { protos, opTable, consts: program.consts, names: program.names, ops: program.ops };
}
// Funciones nativas de metatablas: en el runtime real (Lua) llegan gratis vía _G;
// aquí hay que darlas explícitamente para que la VM de referencia sea equivalente.
// `tostring` necesita el contexto para poder invocar un __tostring definido por el usuario.
function makeMetatableBuiltins(ctx) {
    return {
        setmetatable: (t, mt) => {
            if (!(t instanceof LuaTable))
                throw new RuntimeError("bad argument #1 to 'setmetatable' (table expected)");
            if (mt !== null && mt !== undefined && !(mt instanceof LuaTable)) {
                throw new RuntimeError("bad argument #2 to 'setmetatable' (nil or table expected)");
            }
            t.metatable = mt ?? null;
            return t;
        },
        getmetatable: (t) => (t instanceof LuaTable ? t.metatable : null),
        rawget: (t, k) => {
            if (!(t instanceof LuaTable))
                throw new RuntimeError("bad argument #1 to 'rawget' (table expected)");
            const v = t.hash.get(k);
            return v === undefined ? null : v;
        },
        rawset: (t, k, v) => {
            if (!(t instanceof LuaTable))
                throw new RuntimeError("bad argument #1 to 'rawset' (table expected)");
            if (v === null || v === undefined)
                t.hash.delete(k);
            else
                t.hash.set(k, v);
            return t;
        },
        rawequal: (a, b) => a === b,
        tostring: (v) => {
            const mm = metamethod(v, "__tostring");
            if (mm !== null)
                return first(call(ctx.bc, mm, [v], ctx));
            return tostr(v);
        },
    };
}
export function execute(bc, env, maxSteps = DEFAULT_MAX_STEPS) {
    const ctx = { steps: 0, maxSteps, env, depth: 0, bc };
    // Se agregan solo si el llamador no los definió ya, y sobre el mismo objeto: los
    // llamadores leen `env` después de ejecutar (por ejemplo, para ver globales escritas).
    const builtins = makeMetatableBuiltins(ctx);
    for (const k in builtins)
        if (!(k in env))
            env[k] = builtins[k];
    const results = runFunction(bc, new LuaFunction(bc.protos[0], []), [], ctx);
    return results.length > 0 ? results[0] : null;
}
// Devuelve la lista de resultados de la función (puede ser vacía o tener varios valores).
function runFunction(bc, fn, args, ctx) {
    const proto = fn.proto;
    if (++ctx.depth > MAX_DEPTH)
        throw new RuntimeError("desbordamiento de la pila de llamadas");
    try {
        const cells = [];
        for (let i = 0; i < proto.slots; i++)
            cells.push({ v: null });
        for (let i = 0; i < proto.params; i++)
            cells[i + 1] = { v: args[i] ?? null };
        // Argumentos extra: son los valores de '...'.
        const varargs = args.slice(proto.params);
        const stack = [];
        const push = (v) => { stack.push(v); };
        const pop = () => {
            if (stack.length === 0)
                throw new RuntimeError("pila vacía");
            return stack.pop();
        };
        // Saca n valores de la pila, en su orden original.
        const popN = (n) => {
            const out = [];
            for (let i = 0; i < n; i++)
                out.unshift(pop());
            return out;
        };
        const countOf = () => pop();
        // Empuja una lista de valores seguida de su cantidad.
        const pushAll = (vals) => {
            for (const v of vals)
                push(v);
            push(vals.length);
        };
        let pc = 0;
        while (true) {
            if (++ctx.steps > ctx.maxSteps)
                throw new RuntimeError("límite de ejecución superado");
            const id = proto.code[pc * 2];
            const a = proto.code[pc * 2 + 1];
            pc++;
            const op = bc.opTable[id];
            switch (op) {
                case "CONST":
                    push(bc.consts[a]);
                    break;
                case "LOCAL_GET":
                    push(cells[a].v);
                    break;
                case "LOCAL_SET":
                    cells[a].v = pop();
                    break;
                case "DECL":
                    cells[a] = { v: pop() };
                    break;
                // Locales capturadas: en la VM de referencia toda celda ya es una caja, así que son iguales.
                case "BOX_GET":
                    push(cells[a].v);
                    break;
                case "BOX_SET":
                    cells[a].v = pop();
                    break;
                case "BOX_DECL":
                    cells[a] = { v: pop() };
                    break;
                case "GLOBAL_GET":
                    push(ctx.env[bc.names[a]] ?? null);
                    break;
                case "GLOBAL_SET":
                    ctx.env[bc.names[a]] = pop();
                    break;
                case "UP_GET":
                    push(fn.upvals[a].v);
                    break;
                case "UP_SET":
                    fn.upvals[a].v = pop();
                    break;
                case "BIN": {
                    const right = pop();
                    const left = pop();
                    push(binary(ctx, bc.ops[a], left, right));
                    break;
                }
                case "UN":
                    push(unary(ctx, bc.ops[a], pop()));
                    break;
                case "JMP":
                    pc = a;
                    break;
                case "JMPF":
                    if (!truthy(pop()))
                        pc = a;
                    break;
                case "JMPT":
                    if (truthy(pop()))
                        pc = a;
                    break;
                case "DUP": {
                    const v = pop();
                    push(v);
                    push(v);
                    break;
                }
                case "POP":
                    pop();
                    break;
                case "SWAP": {
                    const b = pop();
                    const c = pop();
                    push(b);
                    push(c);
                    break;
                }
                case "CALL": {
                    const callArgs = [];
                    for (let i = 0; i < a; i++)
                        callArgs.unshift(pop());
                    const callee = pop();
                    push(first(call(bc, callee, callArgs, ctx)));
                    break;
                }
                case "CALLM": {
                    const callArgs = [];
                    for (let i = 0; i < a; i++)
                        callArgs.unshift(pop());
                    const callee = pop();
                    pushAll(call(bc, callee, callArgs, ctx));
                    break;
                }
                case "CALLV": {
                    const callArgs = popN(countOf());
                    const callee = pop();
                    push(first(call(bc, callee, callArgs, ctx)));
                    break;
                }
                case "CALLVM": {
                    const callArgs = popN(countOf());
                    const callee = pop();
                    pushAll(call(bc, callee, callArgs, ctx));
                    break;
                }
                case "ADJ": {
                    const vals = popN(countOf());
                    for (let j = 0; j < a; j++)
                        push(j < vals.length ? vals[j] : null);
                    break;
                }
                case "ADDCOUNT":
                    push(countOf() + a);
                    break;
                case "RETV": return popN(countOf());
                case "VARARG":
                    pushAll(varargs);
                    break;
                case "VARARG1":
                    push(varargs.length > 0 ? varargs[0] : null);
                    break;
                case "SETLIST": {
                    // Pila: [..., tabla, inicio, v1..vk, k]. Consume la tabla duplicada y deja la original.
                    const vals = popN(countOf());
                    const start = pop();
                    const t = pop();
                    vals.forEach((v, j) => setIndex(ctx, t, start + j, v));
                    break;
                }
                case "RET": return [pop()];
                case "CLOSURE": {
                    const child = bc.protos[a];
                    const ups = child.upvals.map((d) => (d.fromLocal ? cells[d.index] : fn.upvals[d.index]));
                    push(new LuaFunction(child, ups));
                    break;
                }
                case "NEWTABLE":
                    push(new LuaTable());
                    break;
                case "INDEX": {
                    const key = pop();
                    const obj = pop();
                    push(index(ctx, obj, key));
                    break;
                }
                case "SETINDEX": {
                    const value = pop();
                    const key = pop();
                    const obj = pop();
                    setIndex(ctx, obj, key, value);
                    break;
                }
                default: throw new RuntimeError(`operación desconocida ${id}`);
            }
        }
    }
    finally {
        ctx.depth--;
    }
}
// Llamada genérica: devuelve la lista de resultados (vacía si la función no devuelve nada).
function call(bc, callee, args, ctx) {
    if (callee instanceof LuaFunction)
        return runFunction(bc, callee, args, ctx);
    if (typeof callee === "function") {
        const result = callee(...args);
        return result === undefined ? [] : [result];
    }
    const mm = metamethod(callee, "__call");
    if (mm !== null)
        return call(bc, mm, [callee, ...args], ctx);
    throw new RuntimeError(`se intentó llamar a un valor de tipo ${typeName(callee)}`);
}
// Primer resultado de una llamada en contexto de un solo valor (nil si no hay ninguno).
function first(results) {
    return results.length > 0 ? results[0] : null;
}
function index(ctx, obj, key) {
    if (obj instanceof LuaTable) {
        const v = obj.hash.get(key);
        if (v !== undefined)
            return v;
        const mm = metamethod(obj, "__index");
        if (mm instanceof LuaTable)
            return index(ctx, mm, key);
        if (mm !== null)
            return first(call(ctx.bc, mm, [obj, key], ctx));
        return null;
    }
    if (typeof obj === "string") {
        // Los strings usan la tabla "string" como metatabla, como en Lua.
        const lib = ctx.env.string;
        if (lib instanceof LuaTable)
            return index(ctx, lib, key);
        return null;
    }
    throw new RuntimeError(`intento de indexar un valor de tipo ${typeName(obj)}`);
}
function setIndex(ctx, obj, key, value) {
    if (!(obj instanceof LuaTable))
        throw new RuntimeError(`intento de asignar a un valor de tipo ${typeName(obj)}`);
    if (key === null || key === undefined)
        throw new RuntimeError("índice nil");
    if (typeof key === "number" && Number.isNaN(key))
        throw new RuntimeError("índice NaN");
    if (!obj.hash.has(key)) {
        const mm = metamethod(obj, "__newindex");
        if (mm instanceof LuaTable)
            return setIndex(ctx, mm, key, value);
        if (mm !== null) {
            call(ctx.bc, mm, [obj, key, value], ctx);
            return;
        }
    }
    if (value === null || value === undefined)
        obj.hash.delete(key);
    else
        obj.hash.set(key, value);
}
export function truthy(v) {
    return v !== null && v !== undefined && v !== false;
}
function typeName(v) {
    if (v === null || v === undefined)
        return "nil";
    if (typeof v === "boolean")
        return "boolean";
    if (typeof v === "number")
        return "number";
    if (typeof v === "string")
        return "string";
    if (v instanceof LuaTable)
        return "table";
    return "function";
}
// Convierte a texto como print/tostring de Lua 5.1 (números con %.14g).
export function tostr(v) {
    if (typeof v === "string")
        return v;
    if (typeof v === "number") {
        if (Number.isInteger(v) && Math.abs(v) < 1e15)
            return String(v);
        return String(Number(v.toPrecision(14)));
    }
    if (v === null || v === undefined)
        return "nil";
    if (typeof v === "boolean")
        return String(v);
    if (v instanceof LuaTable)
        return "table";
    return "function";
}
// Lua solo concatena strings y números; cualquier otro tipo es error.
function concatPart(v) {
    if (typeof v === "string" || typeof v === "number")
        return tostr(v);
    throw new RuntimeError(`intento de concatenar un valor de tipo ${typeName(v)}`);
}
function num(v, what) {
    if (typeof v === "number")
        return v;
    throw new RuntimeError(`intento de ${what} sobre un valor de tipo ${typeName(v)}`);
}
// Nombre del metamétodo aritmético/concat de cada operador binario.
const ARITH_MM = {
    "+": "__add", "-": "__sub", "*": "__mul", "/": "__div", "%": "__mod", "^": "__pow", "..": "__concat",
};
// Busca el metamétodo en l y, si no está, en r (orden de Lua 5.1).
function binMeta(name, l, r) {
    const mm = metamethod(l, name);
    return mm !== null ? mm : metamethod(r, name);
}
function binary(ctx, op, l, r) {
    switch (op) {
        case "+":
        case "-":
        case "*":
        case "/":
        case "%":
        case "^": {
            if (typeof l === "number" && typeof r === "number")
                return arith(op, l, r);
            const mm = binMeta(ARITH_MM[op], l, r);
            if (mm !== null)
                return first(call(ctx.bc, mm, [l, r], ctx));
            const what = { "+": "sumar", "-": "restar", "*": "multiplicar", "/": "dividir", "%": "calcular módulo", "^": "elevar" }[op];
            return arith(op, num(l, what), num(r, what)); // lanza si l o r no es número
        }
        case "//": {
            // División entera de Luau: redondea hacia -infinito.
            if (typeof l === "number" && typeof r === "number")
                return Math.floor(l / r);
            return Math.floor(num(l, "dividir") / num(r, "dividir")); // lanza si l o r no es número
        }
        case "..": {
            if ((typeof l === "string" || typeof l === "number") && (typeof r === "string" || typeof r === "number")) {
                return concatPart(l) + concatPart(r);
            }
            const mm = binMeta("__concat", l, r);
            if (mm !== null)
                return first(call(ctx.bc, mm, [l, r], ctx));
            return concatPart(l) + concatPart(r); // lanza con el mensaje correcto
        }
        case "==":
        case "~=": {
            let eq = l === r;
            if (!eq && l instanceof LuaTable && r instanceof LuaTable) {
                const mm = binMeta("__eq", l, r);
                if (mm !== null)
                    eq = truthy(first(call(ctx.bc, mm, [l, r], ctx)));
            }
            return op === "==" ? eq : !eq;
        }
        case "<":
        case "<=":
        case ">":
        case ">=": {
            // a > b y a >= b son b < a y b <= a, como en Lua.
            const [a, b, le] = op === ">" ? [r, l, false] : op === ">=" ? [r, l, true] : [l, r, op === "<="];
            if (typeof a === typeof b && (typeof a === "number" || typeof a === "string")) {
                return le ? a <= b : a < b;
            }
            const name = le ? "__le" : "__lt";
            let mm = binMeta(name, a, b);
            if (mm !== null)
                return truthy(first(call(ctx.bc, mm, [a, b], ctx)));
            if (le) {
                // Lua 5.1: si no hay __le, usa "not (b < a)" con __lt.
                mm = binMeta("__lt", a, b);
                if (mm !== null)
                    return !truthy(first(call(ctx.bc, mm, [b, a], ctx)));
            }
            throw new RuntimeError(`no se puede comparar ${typeName(l)} con ${typeName(r)}`);
        }
        default: throw new RuntimeError(`operador binario desconocido ${op}`);
    }
}
function arith(op, a, b) {
    switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "%": return a - Math.floor(a / b) * b;
        case "^": return Math.pow(a, b);
        default: throw new RuntimeError(`operador aritmético desconocido ${op}`);
    }
}
function unary(ctx, op, v) {
    switch (op) {
        case "-": {
            if (typeof v === "number")
                return -v;
            const mm = metamethod(v, "__unm");
            if (mm !== null)
                return first(call(ctx.bc, mm, [v, v], ctx));
            return -num(v, "negar");
        }
        case "not": return !truthy(v);
        case "#": {
            if (typeof v === "string")
                return v.length;
            if (v instanceof LuaTable) {
                const mm = metamethod(v, "__len");
                if (mm !== null)
                    return first(call(ctx.bc, mm, [v], ctx));
                let n = 0;
                while (v.hash.has(n + 1))
                    n++;
                return n;
            }
            throw new RuntimeError(`intento de obtener longitud de un valor de tipo ${typeName(v)}`);
        }
        default: throw new RuntimeError(`operador unario desconocido ${op}`);
    }
}
