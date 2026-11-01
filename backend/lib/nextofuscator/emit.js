// Genera el archivo Lua de salida: runtime de la VM + bytecode como literal de tabla.
// Las cadenas (nombres de opcodes, operadores, globales y constantes de texto) van cifradas:
// cada byte se suma a una clave y a un salt por lista y posición, módulo 256. El runtime las
// descifra al cargar. OJO: la clave viaja en el mismo archivo, así que esto oculta las cadenas
// de un vistazo (grep, strings) pero no es un secreto frente a quien lea el runtime.
import { createHash } from "node:crypto";
import { RUNTIME_LUA } from "./runtime.js";
// Salts base por lista. Deben coincidir con decstr() en runtime.ts.
export const SALT = { ops: 1_000_000, names: 2_000_000, consts: 3_000_000, opnames: 4_000_000 };
const KEY_LENGTH = 16;
// Clave por compilación: depende del mapa de opcodes, que cambia con la semilla.
export function deriveKey(bc) {
    const digest = createHash("sha256").update(bc.opTable.join(",")).digest();
    return [...digest.subarray(0, KEY_LENGTH)];
}
// Cifrado por posición: c[i] = (p[i] + clave[i mod n] + salt) mod 256.
export function encryptBytes(plain, salt, key) {
    const out = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++)
        out[i] = (plain[i] + key[i % key.length] + salt) % 256;
    return out;
}
// Literal de cadena Lua con escapes decimales sobre bytes arbitrarios, válido en Lua 5.1.
function luaBytes(bytes) {
    let out = '"';
    for (const byte of bytes) {
        if (byte === 34 || byte === 92)
            out += "\\" + String.fromCharCode(byte);
        else if (byte >= 32 && byte < 127)
            out += String.fromCharCode(byte);
        else
            out += "\\" + String(byte).padStart(3, "0");
    }
    return out + '"';
}
export function luaString(s) {
    return luaBytes(Buffer.from(s, "utf8"));
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
    throw new Error("constante no serializable");
}
function luaList(items) {
    return "{" + items.join(",") + "}";
}
// Literal de tabla Lua con el bytecode de un programa, listo para nx_run.
export function payloadLiteral(bc) {
    const key = deriveKey(bc);
    // Índices base 1, igual que en Lua: el salt de cada cadena es base + índice.
    const enc = (s, base, i) => luaBytes(encryptBytes(Buffer.from(s, "utf8"), base + i + 1, key));
    const protos = bc.protos.map((p) => `{code=${luaList(p.code.map(String))},params=${p.params},slots=${p.slots},` +
        `up=${luaList(p.upvals.map((u) => `{${u.fromLocal ? 1 : 0},${u.index}}`))},` +
        `bp=${luaList(p.boxedParams.map(String))}}`);
    return (`{` +
        `k=${luaList(key.map(String))},` +
        `opnames=${luaList(bc.opTable.map((s, i) => enc(s, SALT.opnames, i)))},` +
        `nconsts=${bc.consts.length},` +
        // Solo las cadenas van cifradas; el runtime distingue cadenas por tipo.
        `consts=${luaList(bc.consts.map((v, i) => (typeof v === "string" ? enc(v, SALT.consts, i) : luaValue(v))))},` +
        `names=${luaList(bc.names.map((s, i) => enc(s, SALT.names, i)))},` +
        `ops=${luaList(bc.ops.map((s, i) => enc(s, SALT.ops, i)))},` +
        `protos=${luaList(protos)}` +
        `}`);
}
export function emitLua(bc, options = {}) {
    const run = options.printResult ? "print(nx_run(P))" : "return nx_run(P)";
    return `-- NextOfuscator\n${RUNTIME_LUA}\nlocal P=${payloadLiteral(bc)}\n${run}\n`;
}
