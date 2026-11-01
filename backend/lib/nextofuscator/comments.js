// Quita los comentarios de código Lua. Respeta cadenas cortas y largas (no tocan su contenido) y
// conserva los saltos de línea, para que los números de línea de los errores no cambien.
const LONG_BRACKET = /\[(=*)\[/y;
export function stripComments(src) {
    const n = src.length;
    let out = "";
    let i = 0;
    while (i < n) {
        const c = src[i];
        // Cadena corta: se copia tal cual, incluidos los escapes.
        if (c === '"' || c === "'") {
            out += c;
            i++;
            while (i < n && src[i] !== c && src[i] !== "\n") {
                if (src[i] === "\\" && i + 1 < n) {
                    out += src[i] + src[i + 1];
                    i += 2;
                }
                else {
                    out += src[i];
                    i++;
                }
            }
            if (i < n && src[i] === c) {
                out += c;
                i++;
            }
            continue;
        }
        // Cadena larga [[...]] o [==[...]==]: no es comentario, se copia completa.
        if (c === "[") {
            LONG_BRACKET.lastIndex = i;
            const m = LONG_BRACKET.exec(src);
            if (m) {
                const close = "]" + m[1] + "]";
                const end = src.indexOf(close, i + m[0].length);
                const stop = end < 0 ? n : end + close.length;
                out += src.slice(i, stop);
                i = stop;
                continue;
            }
        }
        // Comentario.
        if (c === "-" && src[i + 1] === "-") {
            LONG_BRACKET.lastIndex = i + 2;
            const m = LONG_BRACKET.exec(src);
            if (m) {
                const close = "]" + m[1] + "]";
                const end = src.indexOf(close, i + 2 + m[0].length);
                const stop = end < 0 ? n : end + close.length;
                out += src.slice(i, stop).replace(/[^\n]/g, "");
                i = stop;
                continue;
            }
            // Comentario de línea: hasta el salto de línea (que se conserva).
            const eol = src.indexOf("\n", i);
            i = eol < 0 ? n : eol;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
