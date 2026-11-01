// Construcción del archivo de salida con macros de optimización y protección.
//
// Reglas:
// - Por defecto todo el script va en la VM.
// - Bloque "--NXT_LPH_OPTIMIZACION" ... "--NXT_LPH_OPTIMIZACION_END": se emite como Lua nativo (sin lag).
// - Bloque "--NXT_LPH_PROTECCION" ... "--NXT_LPH_PROTECCION_END": si el archivo tiene alguno,
//   solo esos bloques van en la VM y el resto queda nativo.
// - Los macros deben estar a nivel principal y no pueden anidarse.
// - Un bloque nativo y uno protegido no pueden compartir variables "local" a nivel principal
//   (cada uno vive en un contexto distinto). Las globales sí se comparten.
import { compile } from "./compiler.js";
import { payloadLiteral } from "./emit.js";
import { LuaSyntaxError } from "./lexer.js";
import { RUNTIME_LUA } from "./runtime.js";
import { parse } from "./parser.js";
import { encode } from "./vm.js";
export class BuildError extends Error {
    line;
    constructor(message, line) {
        super(line ? `línea ${line}: ${message}` : message);
        this.name = "BuildError";
        this.line = line;
    }
}
const OPT_START = /^\s*--\s*NXT_LPH_OPTIMIZACION\s*$/;
const OPT_END = /^\s*--\s*NXT_LPH_OPTIMIZACION_END\s*$/;
const PROT_START = /^\s*--\s*NXT_LPH_PROTECCION\s*$/;
const PROT_END = /^\s*--\s*NXT_LPH_PROTECCION_END\s*$/;
// Divide el código en segmentos según los macros. `line` es la primera línea del segmento (1-based).
export function splitSegments(source) {
    const lines = source.split(/\r\n|\n|\r/);
    const hasProtection = lines.some((l) => PROT_START.test(l));
    let state = "none";
    let openedAt = 0;
    const kinds = [];
    lines.forEach((line, i) => {
        const lineNo = i + 1;
        if (OPT_START.test(line) || PROT_START.test(line)) {
            if (state !== "none")
                throw new BuildError("los macros no se pueden anidar", lineNo);
            state = OPT_START.test(line) ? "opt" : "prot";
            openedAt = lineNo;
            kinds.push(null);
            return;
        }
        if (OPT_END.test(line) || PROT_END.test(line)) {
            const expected = OPT_END.test(line) ? "opt" : "prot";
            if (state !== expected)
                throw new BuildError("cierre de macro sin apertura correspondiente", lineNo);
            state = "none";
            kinds.push(null);
            return;
        }
        if (state === "opt")
            kinds.push("native");
        else if (state === "prot")
            kinds.push("protected");
        else
            kinds.push(hasProtection ? "native" : "protected");
    });
    if (state !== "none")
        throw new BuildError("macro sin cerrar", openedAt);
    // Agrupa líneas consecutivas del mismo tipo; los marcadores (null) cortan el grupo.
    const segments = [];
    let current = null;
    const flush = () => {
        if (!current)
            return;
        const text = current.lines.join("\n");
        if (text.trim().length > 0)
            segments.push({ kind: current.kind, source: text, line: current.start });
        current = null;
    };
    kinds.forEach((kind, i) => {
        if (kind === null) {
            flush();
            return;
        }
        if (!current || current.kind !== kind) {
            flush();
            current = { kind, start: i + 1, lines: [] };
        }
        current.lines.push(lines[i]);
    });
    flush();
    return segments;
}
// Nombres declarados como locales a nivel principal y nombres referenciados en un bloque.
export function namesOf(block) {
    const declared = new Set();
    const referenced = new Set();
    for (const s of block) {
        if (s.kind === "Local")
            s.names.forEach((n) => declared.add(n));
        if (s.kind === "LocalFunction")
            declared.add(s.name);
    }
    const visitExpr = (e) => {
        switch (e.kind) {
            case "Name":
                referenced.add(e.name);
                return;
            case "Index":
                visitExpr(e.object);
                visitExpr(e.key);
                return;
            case "Call":
                visitExpr(e.callee);
                e.args.forEach(visitExpr);
                return;
            case "MethodCall":
                visitExpr(e.object);
                e.args.forEach(visitExpr);
                return;
            case "Function":
                visitBlock(e.body);
                return;
            case "Table":
                for (const item of e.items) {
                    if (item.kind === "Keyed") {
                        visitExpr(item.key);
                        visitExpr(item.value);
                    }
                    else
                        visitExpr(item.value);
                }
                return;
            case "Binary":
                visitExpr(e.left);
                visitExpr(e.right);
                return;
            case "Unary":
                visitExpr(e.operand);
                return;
            case "Paren":
                visitExpr(e.expr);
                return;
            default: return;
        }
    };
    const visitStmt = (s) => {
        switch (s.kind) {
            case "Local":
                s.values.forEach(visitExpr);
                return;
            case "LocalFunction":
                visitExpr(s.fn);
                return;
            case "FunctionDecl":
                visitExpr(s.target);
                visitExpr(s.fn);
                return;
            case "Assign":
                s.targets.forEach(visitExpr);
                s.values.forEach(visitExpr);
                return;
            case "CallStmt":
                visitExpr(s.call);
                return;
            case "Do":
                visitBlock(s.body);
                return;
            case "While":
                visitExpr(s.cond);
                visitBlock(s.body);
                return;
            case "Repeat":
                visitBlock(s.body);
                visitExpr(s.cond);
                return;
            case "If":
                for (const c of s.clauses) {
                    visitExpr(c.cond);
                    visitBlock(c.body);
                }
                if (s.orElse)
                    visitBlock(s.orElse);
                return;
            case "NumericFor":
                visitExpr(s.start);
                visitExpr(s.limit);
                if (s.step)
                    visitExpr(s.step);
                visitBlock(s.body);
                return;
            case "GenericFor":
                s.iterators.forEach(visitExpr);
                visitBlock(s.body);
                return;
            case "Return":
                s.values.forEach(visitExpr);
                return;
            default: return;
        }
    };
    const visitBlock = (b) => b.forEach(visitStmt);
    visitBlock(block);
    return { declared, referenced };
}
// Construye el archivo Lua final a partir del código fuente.
export function buildLua(source, seed, options = {}) {
    const segments = splitSegments(source);
    if (segments.length === 0)
        throw new BuildError("el script está vacío");
    const parsed = segments.map((seg) => {
        try {
            return parse(seg.source);
        }
        catch (error) {
            if (error instanceof LuaSyntaxError) {
                throw new BuildError(error.message.replace(/^\d+:\d+: /, ""), seg.line + error.line - 1);
            }
            throw error;
        }
    });
    // Variables locales de nivel principal no pueden cruzar entre segmentos.
    const info = parsed.map(namesOf);
    info.forEach((own, i) => {
        own.declared.forEach((name) => {
            info.forEach((other, j) => {
                if (i !== j && other.referenced.has(name)) {
                    throw new BuildError(`la variable local '${name}' se declara en un bloque y se usa fuera de él; usa un nombre distinto o hazla global`, segments[j].line);
                }
            });
        });
    });
    const chunks = [];
    segments.forEach((seg, i) => {
        const last = i === segments.length - 1;
        if (seg.kind === "native") {
            chunks.push(`do\n${seg.source}\nend`);
            return;
        }
        let program;
        try {
            program = compile(parsed[i]);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new BuildError(message.replace(/^línea \d+: /, ""), seg.line + (error.line ?? 1) - 1);
        }
        const bytecode = encode(program, seed + i);
        const run = last && options.printResult ? "print(nx_run(P))" : last ? "return nx_run(P)" : "nx_run(P)";
        chunks.push(`do local P=${payloadLiteral(bytecode)} ${run} end`);
    });
    return {
        code: `-- NextOfuscator\n${RUNTIME_LUA}\n${chunks.join("\n")}\n`,
        segments: segments.length,
    };
}
