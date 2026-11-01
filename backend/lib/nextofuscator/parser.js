// Parser de Lua 5.1 por descenso recursivo. Produce un AST sencillo de objetos con "kind".
import { LuaSyntaxError, tokenize } from "./lexer.js";
// Precedencia de operadores binarios de Lua 5.1: [izquierda, derecha]. Mayor = se liga más fuerte.
const BINARY_PRECEDENCE = {
    or: [1, 1], and: [2, 2],
    "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
    "..": [5, 4], // asociatividad derecha
    "+": [6, 6], "-": [6, 6],
    "*": [7, 7], "/": [7, 7], "%": [7, 7],
    "^": [10, 9], // asociatividad derecha, más fuerte que el unario
};
const UNARY_PRECEDENCE = 8;
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
                    return { kind: "Do", body };
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
                        return { kind: "LocalFunction", name, fn: this.parseFunctionBody(line), line };
                    }
                    const names = [this.expectName()];
                    while (this.accept(","))
                        names.push(this.expectName());
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
        const first = this.expectName();
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
            names.push(this.expectName());
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
        const fn = this.parseFunctionBody(line, isMethod);
        return { kind: "FunctionDecl", target, isMethod, fn, line };
    }
    // Parsea "(params) body end". Con método, "self" se añade como primer parámetro.
    parseFunctionBody(line, isMethod = false) {
        this.expect("(");
        const params = isMethod ? ["self"] : [];
        let isVararg = false;
        if (!this.check(")")) {
            do {
                if (this.accept("...")) {
                    isVararg = true;
                    break;
                }
                params.push(this.expectName());
            } while (this.accept(","));
        }
        this.expect(")");
        const body = this.parseBlock();
        this.expect("end", "function");
        return { kind: "Function", params, isVararg, body, line };
    }
    parseExprStatement() {
        const line = this.current.line;
        const first = this.parseSuffixedExpr();
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
            else if ((t.type === "op" && (t.value === "(" || t.value === "{")) || t.type === "string") {
                expr = { kind: "Call", callee: expr, args: this.parseCallArgs(), line: t.line };
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
    if (t.type === "string")
        return "una cadena";
    if (t.type === "number")
        return `el número ${t.value}`;
    return `'${t.value}'`;
}
