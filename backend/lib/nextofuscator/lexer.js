// Lexer para Lua 5.1 (el dialecto de Luraph y Roblox).
// Sin dependencias: se puede usar desde el servidor y desde pruebas.
export const KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true",
    "until", "while",
]);
// Operadores ordenados de más largo a más corto para el emparejamiento voraz.
const OPERATORS = [
    "...", "..", "==", "~=", "<=", ">=",
    "+", "-", "*", "/", "%", "^", "#", "<", ">", "=",
    "(", ")", "{", "}", "[", "]", ";", ":", ",", ".",
];
export class LuaSyntaxError extends Error {
    line;
    col;
    constructor(message, line, col) {
        super(`${line}:${col}: ${message}`);
        this.name = "LuaSyntaxError";
        this.line = line;
        this.col = col;
    }
}
const SIMPLE_ESCAPES = {
    a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'",
};
const isDigit = (c) => c >= "0" && c <= "9";
const isHexDigit = (c) => /[0-9a-fA-F]/.test(c);
const isNameStart = (c) => /[A-Za-z_]/.test(c);
const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);
export function tokenize(source) {
    const tokens = [];
    let pos = 0;
    let line = 1;
    let lineStart = 0;
    const col = () => pos - lineStart + 1;
    const peek = (offset = 0) => source[pos + offset] ?? "";
    const fail = (message) => {
        throw new LuaSyntaxError(message, line, col());
    };
    // Consume un salto de línea (\n, \r, \n\r o \r\n) y actualiza contadores.
    const consumeNewline = () => {
        const first = source[pos];
        pos++;
        const second = source[pos];
        if ((second === "\n" || second === "\r") && second !== first)
            pos++;
        line++;
        lineStart = pos;
    };
    // Lee un corchete largo "[==[" en la posición actual. Devuelve el nivel o -1 si no es uno.
    const longBracketLevel = () => {
        if (peek() !== "[")
            return -1;
        let p = pos + 1;
        let level = 0;
        while (source[p] === "=") {
            level++;
            p++;
        }
        return source[p] === "[" ? level : -1;
    };
    // Lee el contenido de un corchete largo cuyo "[" de apertura empieza en pos.
    const readLongBracket = (level) => {
        const startLine = line;
        const startCol = col();
        pos += level + 2;
        // Un salto de línea inmediatamente después de la apertura se ignora.
        if (peek() === "\n" || peek() === "\r")
            consumeNewline();
        const close = "]" + "=".repeat(level) + "]";
        const end = source.indexOf(close, pos);
        if (end === -1)
            throw new LuaSyntaxError("corchete largo sin cerrar", startLine, startCol);
        const body = source.slice(pos, end);
        // Actualizar línea/columna por los saltos de línea contenidos.
        for (let i = pos; i < end; i++) {
            if (source[i] === "\n" || source[i] === "\r") {
                const nl = source[i];
                if (!((source[i + 1] === "\n" || source[i + 1] === "\r") && source[i + 1] !== nl))
                    line++;
                lineStart = i + 1;
            }
        }
        pos = end + close.length;
        return body;
    };
    const readString = (quote) => {
        const startLine = line;
        const startCol = col();
        pos++; // comilla de apertura
        let out = "";
        while (true) {
            const c = peek();
            if (c === "" || c === "\n" || c === "\r") {
                throw new LuaSyntaxError("cadena sin cerrar", startLine, startCol);
            }
            if (c === quote) {
                pos++;
                return out;
            }
            if (c !== "\\") {
                out += c;
                pos++;
                continue;
            }
            // Secuencia de escape.
            pos++;
            const e = peek();
            if (e in SIMPLE_ESCAPES) {
                out += SIMPLE_ESCAPES[e];
                pos++;
                continue;
            }
            if (e === "\n" || e === "\r") {
                out += "\n";
                consumeNewline();
                continue;
            }
            if (isDigit(e)) {
                let digits = "";
                while (digits.length < 3 && isDigit(peek())) {
                    digits += peek();
                    pos++;
                }
                const code = Number(digits);
                if (code > 255)
                    fail("escape decimal fuera de rango (máximo \\255)");
                out += String.fromCharCode(code);
                continue;
            }
            fail(`escape inválido \\${e}`);
        }
    };
    const readNumber = () => {
        const start = pos;
        if (peek() === "0" && (peek(1) === "x" || peek(1) === "X")) {
            pos += 2;
            if (!isHexDigit(peek()))
                fail("número hexadecimal incompleto");
            while (isHexDigit(peek()))
                pos++;
            return Number.parseInt(source.slice(start + 2, pos), 16);
        }
        while (isDigit(peek()))
            pos++;
        if (peek() === ".") {
            pos++;
            while (isDigit(peek()))
                pos++;
        }
        if (peek() === "e" || peek() === "E") {
            pos++;
            if (peek() === "+" || peek() === "-")
                pos++;
            if (!isDigit(peek()))
                fail("exponente sin dígitos");
            while (isDigit(peek()))
                pos++;
        }
        if (isNameChar(peek()))
            fail(`número mal formado '${source.slice(start, pos + 1)}'`);
        return Number(source.slice(start, pos));
    };
    while (pos < source.length) {
        const c = peek();
        // Espacios y saltos de línea.
        if (c === "\n" || c === "\r") {
            consumeNewline();
            continue;
        }
        if (c === " " || c === "\t" || c === "\f" || c === "\v") {
            pos++;
            continue;
        }
        // Comentarios: "--" seguido de corchete largo o de línea.
        if (c === "-" && peek(1) === "-") {
            pos += 2;
            const level = longBracketLevel();
            if (level >= 0) {
                readLongBracket(level);
                continue;
            }
            while (pos < source.length && peek() !== "\n" && peek() !== "\r")
                pos++;
            continue;
        }
        const startLine = line;
        const startCol = col();
        const push = (type, value) => tokens.push({ type, value, line: startLine, col: startCol });
        // Cadenas largas [[...]] o [==[...]==].
        if (c === "[") {
            const level = longBracketLevel();
            if (level >= 0) {
                push("string", readLongBracket(level));
                continue;
            }
        }
        if (c === '"' || c === "'") {
            push("string", readString(c));
            continue;
        }
        if (isDigit(c) || (c === "." && isDigit(peek(1)))) {
            push("number", readNumber());
            continue;
        }
        if (isNameStart(c)) {
            const start = pos;
            while (isNameChar(peek()))
                pos++;
            const word = source.slice(start, pos);
            push(KEYWORDS.has(word) ? "keyword" : "name", word);
            continue;
        }
        const op = OPERATORS.find((o) => source.startsWith(o, pos));
        if (op) {
            pos += op.length;
            push("op", op);
            continue;
        }
        fail(`carácter inesperado '${c}'`);
    }
    tokens.push({ type: "eof", value: "<eof>", line, col: col() });
    return tokens;
}
