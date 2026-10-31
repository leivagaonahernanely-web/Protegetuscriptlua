// Ofuscador propio ("Seguro"): cifra cada string literal del script.
//
// Diseño, pensado para ejecutores de Roblox:
// - NO usa loadstring ni load: el código ofuscado es Lua normal. Así no depende de que el
//   ejecutor permita cargar código en tiempo de ejecución (causa habitual de "no ejecuta").
// - Cada string se reemplaza por una llamada a un decodificador. Cada string se descifra
//   una sola vez y se guarda en caché, así que el costo al ejecutar es mínimo.
// - Solo usa aritmética (suma y módulo 256): no depende de bit32 ni de operadores de Lua 5.3,
//   y no tiene problemas de precisión con números grandes.
// - Los nombres internos y la clave son aleatorios en cada ofuscación.
//
// Límite honesto: el script tiene que descifrar sus strings para usarlas, así que alguien con
// tiempo y un depurador puede leerlas. Esto protege contra lectura casual, no contra un ataque
// dirigido.
"use strict";
import crypto from "crypto";

const ESC_SIMPLE = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39 };

// Convierte un code point a bytes UTF-8 (para \u{XXXX})
function utf8Bytes(cp) {
  return Array.from(Buffer.from(String.fromCodePoint(cp), "utf8"));
}

// Normaliza fines de línea como hace Lua dentro de strings largos
function normalizeEol(s) {
  return s.replace(/\r\n|\n\r|\r/g, "\n");
}

// Lee un string corto (empieza en la comilla) y devuelve sus bytes y la posición siguiente
function readShortString(src, start) {
  const q = src[start];
  const bytes = [];
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === q) return { bytes, next: i + 1 };
    if (c === "\n") return { bytes, next: i }; // string sin cerrar: Lua daría error; no lo ocultamos
    if (c !== "\\") {
      const cp = src.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      i += ch.length;
      continue;
    }
    // secuencia de escape
    const e = src[i + 1];
    if (e === undefined) { i++; break; }
    if (e in ESC_SIMPLE) { bytes.push(ESC_SIMPLE[e]); i += 2; continue; }
    if (e === "\n" || e === "\r") {
      bytes.push(10);
      i += 2;
      if ((e === "\r" && src[i] === "\n") || (e === "\n" && src[i] === "\r")) i++;
      continue;
    }
    if (e === "x") {
      const hex = src.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 4; continue; }
      bytes.push(120); i += 2; continue;
    }
    if (/[0-9]/.test(e)) {
      const m = /^[0-9]{1,3}/.exec(src.slice(i + 1, i + 4));
      const v = parseInt(m[0], 10);
      bytes.push(v & 255);
      i += 1 + m[0].length;
      continue;
    }
    if (e === "z") {
      i += 2;
      while (i < n && /\s/.test(src[i])) i++;
      continue;
    }
    if (e === "u" && src[i + 2] === "{") {
      const close = src.indexOf("}", i + 3);
      if (close > 0) {
        const cp = parseInt(src.slice(i + 3, close), 16);
        if (!Number.isNaN(cp)) { for (const b of utf8Bytes(cp)) bytes.push(b); i = close + 1; continue; }
      }
    }
    // escape desconocido: Lua lo rechaza; conservamos el carácter tal cual
    for (const b of Buffer.from(e, "utf8")) bytes.push(b);
    i += 2;
  }
  return { bytes, next: i };
}

// Devuelve el nivel de un corchete largo "[==[" en la posición p, o -1
function longBracketLevel(src, p) {
  if (src[p] !== "[") return -1;
  let j = p + 1, lvl = 0;
  while (src[j] === "=") { lvl++; j++; }
  return src[j] === "[" ? lvl : -1;
}

function obfuscateLuaPro(source) {
  const src = String(source ?? "");
  const n = src.length;
  const K = Array.from(crypto.randomBytes(32));
  const names = {};
  const rid = () => "_" + crypto.randomBytes(5).toString("hex");
  names.tbl = rid(); names.fn = rid(); names.cache = rid(); names.key = rid(); names.enc = rid();

  const encoded = []; // cada entrada: bytes cifrados de un string
  const encode = bytes => {
    const e = new Array(bytes.length);
    for (let j = 1; j <= bytes.length; j++) {
      e[j - 1] = (bytes[j - 1] + K[((j - 1) % 32)] + j * 7) % 256;
    }
    return e;
  };
  const addString = bytes => {
    encoded.push(encode(bytes));
    return `(${names.fn}(${encoded.length}))`;
  };

  let out = "";
  let i = 0;
  while (i < n) {
    const c = src[i];

    // comentarios: "--" de línea o "--[==[" de bloque (se quitan, pero se conservan los saltos)
    if (c === "-" && src[i + 1] === "-") {
      if (src[i + 2] === "[") {
        const lvl = longBracketLevel(src, i + 2);
        if (lvl >= 0) {
          const close = "]" + "=".repeat(lvl) + "]";
          const found = src.indexOf(close, i + 2 + lvl + 2);
          const stop = found < 0 ? n : found + close.length;
          out += src.slice(i, stop).replace(/[^\n]/g, "");
          i = stop;
          continue;
        }
      }
      const eol = src.indexOf("\n", i);
      i = eol < 0 ? n : eol;
      continue;
    }

    // strings largos [[ ]] / [==[ ]==]
    if (c === "[") {
      const lvl = longBracketLevel(src, i);
      if (lvl >= 0) {
        const close = "]" + "=".repeat(lvl) + "]";
        let start = i + lvl + 2;
        if (src[start] === "\r") start++;
        if (src[start] === "\n") start++;
        const found = src.indexOf(close, start);
        const end = found < 0 ? n : found;
        const text = normalizeEol(src.slice(start, end));
        out += addString(Array.from(Buffer.from(text, "utf8")));
        i = found < 0 ? n : found + close.length;
        continue;
      }
    }

    // strings cortos
    if (c === '"' || c === "'") {
      const { bytes, next } = readShortString(src, i);
      out += addString(bytes);
      i = next;
      continue;
    }

    // template strings de Luau (`...`): se copian tal cual, respetando escapes
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    out += c;
    i++;
  }

  const keyLua = K.join(",");
  const encLua = encoded.map(e => "{" + e.join(",") + "}").join(",");
  const header = `local ${names.tbl}={K={${keyLua}},E={${encLua}},C={}}`;
  const decoder = `local function ${names.fn}(i)` +
    ` local v=${names.tbl}.C[i] if v then return v end` +
    ` local e=${names.tbl}.E[i] local t={} local K=${names.tbl}.K` +
    ` for j=1,#e do t[j]=string.char((e[j]-K[((j-1)%32)+1]-j*7)%256) end` +
    ` v=table.concat(t) ${names.tbl}.C[i]=v return v end`;
  return `${header} ${decoder}\n${out}`;
}

export { obfuscateLuaPro };
