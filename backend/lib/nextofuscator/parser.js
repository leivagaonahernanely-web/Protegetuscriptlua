// Parser de Lua 5.1 con las extensiones de Luau que usa Roblox, por descenso recursivo.
// Las anotaciones de tipo se leen y se descartan; los operadores compuestos (+=, ..=) se
// convierten en asignaciones; `if` como expresión e interpolación con backticks producen AST normal.
import { LuaSyntaxError, tokenize } from "./lexer.js";
// Precedencia de operadores binarios de Lua 5.1 (más // de Luau): [izquierda, derecha]. Mayor = se liga más fuerte.
const BINARY_PRECEDENCE = {
    or: [1, 1], and: [2, 2],
    "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
    "..": [5, 4], // asociatividad derecha
    "+": [6, 6], "-": [6, 6],
    "*": [7, 7], "/": [7, 7], "//": [7, 7], "%": [7, 7],
    "^": [10, 9], // asociatividad derecha, más fuerte que el unario
};
const UNARY_PRECEDENCE = 8;
// Operadores compuestos de Luau y el operador binario que representan.
const COMPOUND_OPS = {
    "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%", "^=": "^", "..=": "..",
};
const BLOCK_END = new Set(["end", "else", "elseif", "until", "<eof>"]);
export function parse(source) {
    return new Parser(tokenize(source)).parseChunk();
}
class Parser {
    pos = 0;
    tokens;
    constructor(tokens) {
        this.tokens = tokens;
    }
    get current() { return this.tokens[this.pos]; }
    next() { return this.tokens[this.pos++]; }
    check(value) {
        const t = this.current;
        return (t.type === "op" || t.type === "keyword") && t.value === value;
    }
    accept(value) {
        if (this.check(value)) {
            this.pos++;
            return true;
        }
        return false;
    }
    expect(value, context) {
        if (this.check(value))
            return this.next();
        const where = context ? ` (para cerrar ${context})` : "";
        this.fail(`se esperaba '${value}'${where} y se encontró ${describe(this.current)}`);
    }
    expectName() {
        const t = this.current;
        if (t.type !== "name")
            this.fail(`se esperaba un nombre y se encontró ${describe(t)}`);
        this.pos++;
        return t.value;
    }
    fail(message) {
        const t = this.current;
        throw new LuaSyntaxError(message, t.line, t.col);
    }
    parseChunk() {
        const block = this.parseBlock();
        if (this.current.type !== "eof")
            this.fail(`se esperaba fin de fragmento y se encontró ${describe(this.current)}`);
        return block;
    }
    // Expresión completa: no puede quedar nada detrás (usado para interpolaciones).
    parseWholeExpr() {
        const e = this.parseExpr();
        if (this.current.type !== "eof")
            this.fail(`se esperaba fin de la expresión y se encontró ${describe(this.current)}`);
        return e;
    }
    parseBlock() {
        const stmts = [];
        while (!(this.current.type === "eof" || (this.current.type === "keyword" && BLOCK_END.has(this.current.value)))) {
            if (this.check("return")) {
                stmts.push(this.parseReturn());
                break;
            }
            const stmt = this.parseStatement();
            if (stmt)
                stmts.push(stmt);
        }
        return stmts;
    }
    parseReturn() {
        const line = this.next().line;
        let values = [];
        if (!this.blockEndsHere() && !this.check(";"))
            values = this.parseExprList();
        this.accept(";");
        if (!this.blockEndsHere())
            this.fail("'return' debe ser la última sentencia del bloque");
        return { kind: "Return", values, line };
    }
    blockEndsHere() {
        const t = this.current;
        return t.type === "eof" || (t.type === "keyword" && BLOCK_END.has(t.value));
    }
    parseStatement() {
        const t = this.current;
        const line = t.line;
        if (t.type === "op" && t.value === ";") {
            this.pos++;
            return null;
        }
        // Luau: `continue` es sentencia salvo que se use como nombre (continue = 1, continue(), continue.x).
        if (t.type === "name" && t.value === "continue" && this.continueIsStatement()) {
            this.pos++;
            return { kind: "Continue", line };
        }
        // Luau: alias de tipo (`type X = ...`, `export type X = ...`). No generan código.
        if (t.type === "name" && t.value === "export" && this.isTypeAliasAt(this.pos + 1)) {
            this.pos++;
            this.skipTypeAlias();
            return null;
        }
        if (t.type === "name" && t.value === "type" && this.isTypeAliasAt(this.pos)) {
            this.skipTypeAlias();
            return null;
        }
        if (t.type === "keyword") {
            switch (t.value) {
                case "if": return this.parseIf();
                case "while": {
                    this.pos++;
                    const cond = this.parseExpr();
                    this.expect("do");
                    const body = this.parseBlock();
                    this.expect("end", "while");
                    return { kind: "While", cond, body, line };
                }
                case "do": {
                    this.pos++;
                    const body = this.parseBlock();
                    this.expect("end", "do");
                    return { kind: "Do", body, line };
                }
                case "for": return this.parseFor();
                case "repeat": {
                    this.pos++;
                    const body = this.parseBlock();
                    this.expect("until", "repeat");
                    return { kind: "Repeat", body, cond: this.parseExpr(), line };
                }
                case "function": return this.parseFunctionDecl();
                case "local": {
                    this.pos++;
                    if (this.accept("function")) {
                        const name = this.expectName();
                        this.skipGenerics();
                        return { kind: "LocalFunction", name, fn: this.parseFunctionBody(line), line };
                    }
                    const names = [this.parseTypedName()];
                    while (this.accept(","))
                        names.push(this.parseTypedName());
                    const values = this.accept("=") ? this.parseExprList() : [];
                    return { kind: "Local", names, values, line };
                }
                case "break":
                    this.pos++;
                    return { kind: "Break", line };
                default: break;
            }
        }
        return this.parseExprStatement();
    }
    // `continue` cuenta como sentencia si no lo sigue un token que lo convierta en expresión o en asignación.
    continueIsStatement() {
        const n = this.tokens[this.pos + 1];
        if (!n)
            return true;
        if (n.type === "string" || n.type === "tstring")
            return false;
        if (n.type === "op") {
            return !["=", ",", ".", "[", ":", "(", "{", ...Object.keys(COMPOUND_OPS)].includes(n.value);
        }
        return true;
    }
    // ¿Hay `type Nombre =` o `type Nombre<...> =` empezando en esa posición?
    isTypeAliasAt(index) {
        const kw = this.tokens[index];
        const name = this.tokens[index + 1];
        const after = this.tokens[index + 2];
        if (!kw || kw.type !== "name" || kw.value !== "type")
            return false;
        if (!name || name.type !== "name")
            return false;
        return after !== undefined && after.type === "op" && (after.value === "=" || after.value === "<");
    }
    skipTypeAlias() {
        this.pos++; // 'type'
        this.expectName();
        this.skipGenerics();
        this.expect("=");
        this.skipType();
    }
    parseIf() {
        const line = this.next().line; // 'if'
        const clauses = [];
        const cond = this.parseExpr();
        this.expect("then");
        clauses.push({ cond, body: this.parseBlock() });
        let orElse = null;
        while (true) {
            if (this.accept("elseif")) {
                const c = this.parseExpr();
                this.expect("then");
                clauses.push({ cond: c, body: this.parseBlock() });
            }
            else if (this.accept("else")) {
                orElse = this.parseBlock();
                this.expect("end", "if");
                break;
            }
            else {
                this.expect("end", "if");
                break;
            }
        }
        return { kind: "If", clauses, orElse, line };
    }
    parseFor() {
        const line = this.next().line; // 'for'
        const first = this.parseTypedName();
        if (this.accept("=")) {
            const start = this.parseExpr();
            this.expect(",");
            const limit = this.parseExpr();
            const step = this.accept(",") ? this.parseExpr() : null;
            this.expect("do");
            const body = this.parseBlock();
            this.expect("end", "for");
            return { kind: "NumericFor", name: first, start, limit, step, body, line };
        }
        const names = [first];
        while (this.accept(","))
            names.push(this.parseTypedName());
        this.expect("in");
        const iterators = this.parseExprList();
        this.expect("do");
        const body = this.parseBlock();
        this.expect("end", "for");
        return { kind: "GenericFor", names, iterators, body, line };
    }
    parseFunctionDecl() {
        const line = this.next().line; // 'function'
        let target = { kind: "Name", name: this.expectName(), line };
        let isMethod = false;
        while (this.check(".") || this.check(":")) {
            const sep = this.next().value;
            const key = this.expectName();
            target = { kind: "Index", object: target, key: { kind: "String", value: key } };
            if (sep === ":") {
                isMethod = true;
                break;
            }
        }
        this.skipGenerics();
        const fn = this.parseFunctionBody(line, isMethod);
        return { kind: "FunctionDecl", target, isMethod, fn, line };
    }
    // Parsea "(params): tipo? body end". Con método, "self" se añade como primer parámetro.
    parseFunctionBody(line, isMethod = false) {
        this.expect("(");
        const params = isMethod ? ["self"] : [];
        let isVararg = false;
        if (!this.check(")")) {
            do {
                if (this.accept("...")) {
                    isVararg = true;
                    if (this.accept(":"))
                        this.skipType();
                    break;
                }
                params.push(this.parseTypedName());
            } while (this.accept(","));
        }
        this.expect(")");
        if (this.accept(":"))
            this.skipType(); // tipo de retorno
        const body = this.parseBlock();
        this.expect("end", "function");
        return { kind: "Function", params, isVararg, body, line };
    }
    // Nombre con anotación opcional de tipo (`x: number`). La anotación se descarta.
    parseTypedName() {
        const name = this.expectName();
        if (this.accept(":"))
            this.skipType();
        return name;
    }
    // Salta un bloque de genéricos `<T, U>` si lo hay.
    skipGenerics() {
        if (!this.check("<"))
            return;
        let depth = 0;
        do {
            if (this.check("<"))
                depth++;
            else if (this.check(">"))
                depth--;
            else if (this.current.type === "eof")
                this.fail("genéricos sin cerrar");
            this.pos++;
        } while (depth > 0);
    }
    // Salta una anotación de tipo de Luau. Se detiene en el primer token que no puede formar parte del tipo:
    // una coma, un cierre, `=`, un salto de línea seguido de otra sentencia, o una palabra clave.
    skipType() {
        let depth = 0;
        let prev = this.tokens[this.pos - 1];
        const continuation = new Set(["|", "&", "?", "->"]);
        while (true) {
            const t = this.current;
            if (t.type === "eof")
                return;
            if (depth === 0) {
                if (t.type === "keyword" && !["nil", "true", "false"].includes(t.value))
                    return;
                if (t.type === "op" && [",", "=", ";", ")", "]", "}", ">"].includes(t.value))
                    return;
                if (t.line > prev.line && !(t.type === "op" && continuation.has(t.value)))
                    return;
            }
            if (t.type === "op" && ["(", "{", "[", "<"].includes(t.value))
                depth++;
            else if (t.type === "op" && [")", "}", "]", ">"].includes(t.value))
                depth--;
            prev = t;
            this.pos++;
        }
    }
    parseExprStatement() {
        const line = this.current.line;
        const first = this.parseSuffixedExpr();
        // Luau: `a += b` equivale a `a = a + b` (si `a` tiene efectos, se evalúa dos veces).
        const compound = this.current.type === "op" ? COMPOUND_OPS[this.current.value] : undefined;
        if (compound) {
            if (first.kind !== "Name" && first.kind !== "Index")
                this.fail("no se puede asignar a esta expresión");
            this.pos++;
            const rhs = this.parseExpr();
            return { kind: "Assign", targets: [first], values: [{ kind: "Binary", op: compound, left: first, right: rhs, line }], line };
        }
        if (this.check("=") || this.check(",")) {
            const targets = [first];
            while (this.accept(","))
                targets.push(this.parseSuffixedExpr());
            this.expect("=");
            for (const t of targets) {
                if (t.kind !== "Name" && t.kind !== "Index")
                    this.fail("no se puede asignar a esta expresión");
            }
            return { kind: "Assign", targets, values: this.parseExprList(), line };
        }
        if (first.kind !== "Call" && first.kind !== "MethodCall")
            this.fail("expresión sin efecto: se esperaba una llamada o asignación");
        return { kind: "CallStmt", call: first, line };
    }
    parseExprList() {
        const list = [this.parseExpr()];
        while (this.accept(","))
            list.push(this.parseExpr());
        return list;
    }
    parseExpr(limit = 0) {
        let left;
        const t = this.current;
        if (t.type === "keyword" && (t.value === "not")) {
            this.pos++;
            left = { kind: "Unary", op: "not", operand: this.parseExpr(UNARY_PRECEDENCE), line: t.line };
        }
        else if (t.type === "op" && (t.value === "-" || t.value === "#")) {
            this.pos++;
            left = { kind: "Unary", op: t.value, operand: this.parseExpr(UNARY_PRECEDENCE), line: t.line };
        }
        else {
            left = this.parseSimpleExpr();
        }
        // Luau: conversiones de tipo `x :: T` también después de literales.
        while (this.check("::")) {
            this.pos++;
            this.skipType();
        }
        while (true) {
            const op = this.current;
            const key = op.type === "op" || op.type === "keyword" ? String(op.value) : "";
            const prec = BINARY_PRECEDENCE[key];
            if (!prec || prec[0] <= limit)
                break;
            this.pos++;
            const right = this.parseExpr(prec[1]);
            left = { kind: "Binary", op: key, left, right, line: op.line };
        }
        return left;
    }
    parseSimpleExpr() {
        const t = this.current;
        switch (t.type) {
            case "number":
                this.pos++;
                return { kind: "Number", value: t.value };
            case "string":
                this.pos++;
                return { kind: "String", value: t.value };
            case "tstring":
                this.pos++;
                return this.parseInterpolated(t);
            case "keyword":
                if (t.value === "nil") {
                    this.pos++;
                    return { kind: "Nil" };
                }
                if (t.value === "true") {
                    this.pos++;
                    return { kind: "True" };
                }
                if (t.value === "false") {
                    this.pos++;
                    return { kind: "False" };
                }
                if (t.value === "function") {
                    this.pos++;
                    return this.parseFunctionBody(t.line);
                }
                if (t.value === "if")
                    return this.parseIfExpr();
                break;
            case "op":
                if (t.value === "...") {
                    this.pos++;
                    return { kind: "Vararg" };
                }
                if (t.value === "{")
                    return this.parseTable();
                break;
            default: break;
        }
        return this.parseSuffixedExpr();
    }
    // Luau: `if c then a elseif d then b else e` como expresión.
    parseIfExpr() {
        const line = this.next().line; // 'if'
        const clauses = [];
        const cond = this.parseExpr();
        this.expect("then");
        clauses.push({ cond, value: this.parseExpr() });
        while (this.accept("elseif")) {
            const c = this.parseExpr();
            this.expect("then");
            clauses.push({ cond: c, value: this.parseExpr() });
        }
        this.expect("else", "la expresión if");
        const orElse = this.parseExpr();
        return { kind: "IfExpr", clauses, orElse, line };
    }
    // Luau: interpolación con backticks. `a{x}b` se convierte en "a" .. tostring(x) .. "b".
    parseInterpolated(t) {
        const raw = t.value;
        const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "{": "{", "}": "}", '"': '"', "'": "'" };
        const parts = [];
        let text = "";
        const flush = () => {
            if (text) {
                parts.push({ kind: "String", value: text });
                text = "";
            }
        };
        let i = 0;
        while (i < raw.length) {
            const c = raw[i];
            if (c === "\\") {
                const e = raw[i + 1];
                if (!(e in escapes))
                    throw new LuaSyntaxError(`escape inválido \\${e} en cadena con backticks`, t.line, t.col);
                text += escapes[e];
                i += 2;
                continue;
            }
            if (c === "{") {
                let depth = 0;
                let j = i;
                for (; j < raw.length; j++) {
                    if (raw[j] === "{")
                        depth++;
                    else if (raw[j] === "}" && --depth === 0)
                        break;
                }
                if (j >= raw.length)
                    throw new LuaSyntaxError("llave sin cerrar en cadena con backticks", t.line, t.col);
                flush();
                const inner = new Parser(tokenize(raw.slice(i + 1, j))).parseWholeExpr();
                parts.push({ kind: "Call", callee: { kind: "Name", name: "tostring", line: t.line }, args: [inner], line: t.line });
                i = j + 1;
                continue;
            }
            text += c;
            i++;
        }
        flush();
        if (parts.length === 0)
            return { kind: "String", value: "" };
        return parts.reduce((left, right) => ({ kind: "Binary", op: "..", left, right, line: t.line }));
    }
    parsePrimaryExpr() {
        const t = this.current;
        if (t.type === "name") {
            this.pos++;
            return { kind: "Name", name: t.value, line: t.line };
        }
        if (this.accept("(")) {
            const expr = this.parseExpr();
            this.expect(")", "la expresión entre paréntesis");
            return { kind: "Paren", expr };
        }
        this.fail(`se esperaba una expresión y se encontró ${describe(t)}`);
    }
    parseSuffixedExpr() {
        let expr = this.parsePrimaryExpr();
        while (true) {
            const t = this.current;
            if (t.type === "op" && t.value === ".") {
                this.pos++;
                expr = { kind: "Index", object: expr, key: { kind: "String", value: this.expectName() } };
            }
            else if (t.type === "op" && t.value === "[") {
                this.pos++;
                const key = this.parseExpr();
                this.expect("]");
                expr = { kind: "Index", object: expr, key };
            }
            else if (t.type === "op" && t.value === ":") {
                this.pos++;
                const method = this.expectName();
                expr = { kind: "MethodCall", object: expr, method, args: this.parseCallArgs(), line: t.line };
            }
            else if ((t.type === "op" && (t.value === "(" || t.value === "{")) || t.type === "string" || t.type === "tstring") {
                expr = { kind: "Call", callee: expr, args: this.parseCallArgs(), line: t.line };
            }
            else if (t.type === "op" && t.value === "::") {
                // Luau: conversión de tipo `x :: T`. Solo se descarta el tipo.
                this.pos++;
                this.skipType();
            }
            else {
                return expr;
            }
        }
    }
    parseCallArgs() {
        const t = this.current;
        if (t.type === "string") {
            this.pos++;
            return [{ kind: "String", value: t.value }];
        }
        if (t.type === "tstring") {
            this.pos++;
            return [this.parseInterpolated(t)];
        }
        if (t.type === "op" && t.value === "{")
            return [this.parseTable()];
        if (this.accept("(")) {
            if (this.accept(")"))
                return [];
            const args = this.parseExprList();
            this.expect(")", "la lista de argumentos");
            return args;
        }
        this.fail(`se esperaban argumentos y se encontró ${describe(t)}`);
    }
    parseTable() {
        this.expect("{");
        const items = [];
        while (!this.check("}")) {
            if (this.accept("[")) {
                const key = this.parseExpr();
                this.expect("]");
                this.expect("=");
                items.push({ kind: "Keyed", key, value: this.parseExpr() });
            }
            else if (this.current.type === "name" && this.tokens[this.pos + 1]?.value === "=") {
                const key = this.expectName();
                this.expect("=");
                items.push({ kind: "Named", key, value: this.parseExpr() });
            }
            else {
                items.push({ kind: "Positional", value: this.parseExpr() });
            }
            if (!this.accept(",") && !this.accept(";"))
                break;
        }
        this.expect("}", "la tabla");
        return { kind: "Table", items };
    }
}
function describe(t) {
    if (t.type === "eof")
        return "fin del archivo";
    if (t.type === "string" || t.type === "tstring")
        return "una cadena";
    if (t.type === "number")
        return `el número ${t.value}`;
    return `'${t.value}'`;
}
