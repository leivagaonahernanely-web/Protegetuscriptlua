// Renombra las variables locales del runtime a nombres cortos y quita espacios sobrantes.
// Es conservador: un nombre que aparezca como campo (`x.nombre`, `x:nombre`, `{ nombre = ... }`)
// o que sea global del entorno (string, type, pcall...) no se toca, así que el cambio no altera
// lo que hace el código. El nombre de la función de entrada (nx_run) tampoco se cambia porque
// el archivo generado la llama por ese nombre.
const KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
    "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);
// Globales del entorno de Lua/Luau que el runtime usa; no se renombran aunque también se declaren.
const GLOBALS = new Set([
    "_G", "getfenv", "getmetatable", "setmetatable", "rawequal", "rawget", "rawset", "next", "pairs",
    "ipairs", "select", "error", "pcall", "tostring", "tonumber", "type", "unpack", "print",
    "string", "table", "math", "os", "io", "coroutine", "debug", "utf8", "game", "task", "script",
    "typeof", "getgenv", "bit32", "bit", "pack", "__call",
]);
const KEEP = new Set(["nx_run"]);
function tokenize(src) {
    const toks = [];
    let i = 0;
    let ws = "";
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) {
            ws += c;
            i++;
            continue;
        }
        if (c === "-" && src[i + 1] === "-") {
            // Los comentarios ya se quitaron antes; por si acaso, se descartan hasta el fin de línea.
            while (i < src.length && src[i] !== "\n")
                i++;
            ws += "\n";
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < src.length && src[j] !== c)
                j += src[j] === "\\" ? 2 : 1;
            toks.push({ t: "str", v: src.slice(i, j + 1), ws });
            ws = "";
            i = j + 1;
            continue;
        }
        if (/[0-9]/.test(c)) {
            let j = i;
            while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]))
                j++;
            toks.push({ t: "num", v: src.slice(i, j), ws });
            ws = "";
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_]/.test(src[j]))
                j++;
            const word = src.slice(i, j);
            toks.push({ t: KEYWORDS.has(word) ? "kw" : "id", v: word, ws });
            ws = "";
            i = j;
            continue;
        }
        const two = src.slice(i, i + 3) === "..." ? "..." : src.slice(i, i + 2);
        const op = ["...", "..", "==", "~=", "<=", ">=", "::"].includes(two) ? two : c;
        toks.push({ t: "op", v: op, ws });
        ws = "";
        i += op.length;
    }
    return toks;
}
function declaredNames(toks) {
    const decl = new Set();
    for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.t === "kw" && tk.v === "local") {
            let j = i + 1;
            if (toks[j]?.v === "function") {
                j++;
                if (toks[j]?.t === "id")
                    decl.add(toks[j].v);
                continue;
            }
            while (toks[j]?.t === "id") {
                decl.add(toks[j].v);
                if (toks[j + 1]?.v === ",")
                    j += 2;
                else
                    break;
            }
        }
        if (tk.t === "kw" && tk.v === "for") {
            let j = i + 1;
            while (toks[j] && (toks[j].t === "id" || toks[j].v === ",")) {
                if (toks[j].t === "id")
                    decl.add(toks[j].v);
                j++;
            }
        }
        if (tk.t === "kw" && tk.v === "function") {
            // Parámetros: los identificadores dentro de (...) justo después de 'function' o de su nombre.
            let j = i + 1;
            while (toks[j] && (toks[j].t === "id" || toks[j].v === "." || toks[j].v === ":"))
                j++;
            if (toks[j]?.v === "(") {
                j++;
                while (toks[j] && toks[j].v !== ")") {
                    if (toks[j].t === "id")
                        decl.add(toks[j].v);
                    j++;
                }
            }
        }
    }
    return decl;
}
function fieldNames(toks) {
    const fields = new Set();
    const stack = [];
    for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.t === "op" && (tk.v === "{" || tk.v === "(" || tk.v === "["))
            stack.push(tk.v);
        if (tk.t === "op" && (tk.v === "}" || tk.v === ")" || tk.v === "]"))
            stack.pop();
        if (tk.t !== "id")
            continue;
        const prev = toks[i - 1];
        if (prev && prev.t === "op" && (prev.v === "." || prev.v === ":"))
            fields.add(tk.v);
        const next = toks[i + 1];
        if (next && next.t === "op" && next.v === "=" && stack[stack.length - 1] === "{")
            fields.add(tk.v);
    }
    return fields;
}
function shortNames(avoid) {
    const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    function* gen() {
        for (const a of alpha)
            yield a;
        for (const a of alpha)
            for (const b of alpha)
                yield a + b;
    }
    const it = gen();
    return (function* () {
        for (const n of it)
            if (!avoid.has(n) && !KEYWORDS.has(n))
                yield n;
    })();
}
export function minifyLua(src) {
    const toks = tokenize(src);
    const declared = declaredNames(toks);
    const fields = fieldNames(toks);
    const allIds = new Set(toks.filter((t) => t.t === "id").map((t) => t.v));
    const rename = new Set();
    for (const n of declared) {
        if (GLOBALS.has(n) || KEEP.has(n) || fields.has(n))
            continue;
        rename.add(n);
    }
    // Nombres nuevos: no pueden coincidir con globales ni con identificadores que no se renombran.
    const avoid = new Set([...GLOBALS, ...KEEP]);
    for (const n of allIds)
        if (!rename.has(n))
            avoid.add(n);
    const pool = shortNames(avoid);
    const mapping = new Map();
    for (const n of rename)
        mapping.set(n, pool.next().value);
    let out = "";
    for (const tk of toks) {
        const ws = tk.ws.includes("\n") ? "\n" : tk.ws.length > 0 ? " " : "";
        out += ws;
        out += tk.t === "id" && mapping.has(tk.v) ? mapping.get(tk.v) : tk.v;
    }
    return out.trim();
}
