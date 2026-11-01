// Genera el archivo Lua de salida: runtime de la VM + bytecode cifrado como literal de tabla.
import { RUNTIME_LUA } from "./runtime.js";
// Literal de cadena Lua con escapes decimales sobre los bytes UTF-8, válido en Lua 5.1.
export function luaString(s) {
    let out = '"';
    for (const byte of Buffer.from(s, "utf8")) {
        if (byte === 34 || byte === 92)
            out += "\\" + String.fromCharCode(byte);
        else if (byte >= 32 && byte < 127)
            out += String.fromCharCode(byte);
        else
            out += "\\" + String(byte).padStart(3, "0");
    }
    return out + '"';
}
function luaNumber(n) {
    if (Number.isNaN(n))
        return "(0/0)";
    if (n === Infinity)
        return "(1/0)";
    if (n === -Infinity)
        return "(-1/0)";
    return String(n);
}
function luaValue(v) {
    if (v === null || v === undefined)
        return "nil";
    if (typeof v === "boolean")
        return v ? "true" : "false";
    if (typeof v === "number")
        return luaNumber(v);
    if (typeof v === "string")
        return luaString(v);
    throw new Error("constante no serializable");
}
function luaList(items) {
    return "{" + items.join(",") + "}";
}
// Literal de tabla Lua con el bytecode de un programa, listo para nx_run.
export function payloadLiteral(bc) {
    const protos = bc.protos.map((p) => `{code=${luaList(p.code.map(String))},params=${p.params},slots=${p.slots},` +
        `up=${luaList(p.upvals.map((u) => `{${u.fromLocal ? 1 : 0},${u.index}}`))}}`);
    return (`{` +
        `opnames=${luaList(bc.opTable.map(luaString))},` +
        `consts=${luaList(bc.consts.map(luaValue))},` +
        `names=${luaList(bc.names.map(luaString))},` +
        `ops=${luaList(bc.ops.map(luaString))},` +
        `protos=${luaList(protos)}` +
        `}`);
}
export function emitLua(bc, options = {}) {
    const run = options.printResult ? "print(nx_run(P))" : "return nx_run(P)";
    return `-- NextOfuscator\n${RUNTIME_LUA}\nlocal P=${payloadLiteral(bc)}\n${run}\n`;
}
