export const OP_NAMES = [
    "CONST", "LOCAL_GET", "LOCAL_SET", "DECL", "GLOBAL_GET", "GLOBAL_SET", "UP_GET", "UP_SET",
    "BIN", "UN", "JMP", "JMPF", "JMPT", "DUP", "POP", "SWAP", "CALL", "RET", "CLOSURE",
    "NEWTABLE", "INDEX", "SETINDEX",
];
export class CompileError extends Error {
    line;
    constructor(message, line) {
        super(line ? `línea ${line}: ${message}` : message);
        this.name = "CompileError";
        this.line = line;
    }
}
export function compile(block) {
    return new Compiler().compileMain(block);
}
class Compiler {
    consts = [];
    names = [];
    ops = [];
    protos = [];
    fns = [];
    compileMain(block) {
        this.functionProto([], block, false);
        return { protos: this.protos, consts: this.consts, names: this.names, ops: this.ops };
    }
    get fn() { return this.fns[this.fns.length - 1]; }
    emit(op, a) {
        const instr = a === undefined ? { op } : { op, a };
        this.fn.code.push(instr);
        return this.fn.code.length - 1;
    }
    here() { return this.fn.code.length; }
    patch(at, target) {
        this.fn.code[at].a = target;
    }
    // Compila una función y devuelve el índice de su prototipo.
    functionProto(params, body, isVararg, line) {
        if (isVararg)
            throw new CompileError("varargs (...) todavía no soportados", line);
        const index = this.protos.length;
        this.protos.push(null); // reserva el índice antes de compilar anidadas
        this.fns.push({ code: [], scopes: [new Map()], slots: 0, loops: [], upvals: [], upvalNames: new Map() });
        for (const p of params)
            this.declareLocal(p);
        this.block(body, false);
        this.emit("CONST", this.constIndex(null));
        this.emit("RET");
        const state = this.fns.pop();
        this.protos[index] = { code: state.code, params: params.length, slots: state.slots, upvals: state.upvals };
        return index;
    }
    constIndex(value) {
        const i = this.consts.findIndex((c) => Object.is(c, value));
        if (i !== -1)
            return i;
        this.consts.push(value);
        return this.consts.length - 1;
    }
    nameIndex(name) {
        let i = this.names.indexOf(name);
        if (i === -1) {
            this.names.push(name);
            i = this.names.length - 1;
        }
        return i;
    }
    opIndex(op) {
        let i = this.ops.indexOf(op);
        if (i === -1) {
            this.ops.push(op);
            i = this.ops.length - 1;
        }
        return i;
    }
    findLocal(st, name) {
        for (let i = st.scopes.length - 1; i >= 0; i--) {
            const slot = st.scopes[i].get(name);
            if (slot !== undefined)
                return slot;
        }
        return undefined;
    }
    // Devuelve el índice de upvalue de `name` en el nivel `level`, o -1 si es global.
    upvalIndex(level, name) {
        const st = this.fns[level];
        const known = st.upvalNames.get(name);
        if (known !== undefined)
            return known;
        if (level === 0)
            return -1;
        const parent = this.fns[level - 1];
        const local = this.findLocal(parent, name);
        let desc;
        if (local !== undefined) {
            desc = { fromLocal: true, index: local };
        }
        else {
            const outer = this.upvalIndex(level - 1, name);
            if (outer < 0)
                return -1;
            desc = { fromLocal: false, index: outer };
        }
        st.upvals.push(desc);
        const idx = st.upvals.length - 1;
        st.upvalNames.set(name, idx);
        return idx;
    }
    lookup(name) {
        const top = this.fns.length - 1;
        const slot = this.findLocal(this.fn, name);
        if (slot !== undefined)
            return { kind: "local", a: slot };
        const up = this.upvalIndex(top, name);
        if (up >= 0)
            return { kind: "up", a: up };
        return { kind: "global", a: this.nameIndex(name) };
    }
    declareLocal(name) {
        const slot = this.fn.slots++;
        this.fn.scopes[this.fn.scopes.length - 1].set(name, slot);
        return slot;
    }
    newTemp() { return this.fn.slots++; }
    block(stmts, newScope = true) {
        if (newScope)
            this.fn.scopes.push(new Map());
        for (const s of stmts)
            this.statement(s);
        if (newScope)
            this.fn.scopes.pop();
    }
    storeName(name) {
        const ref = this.lookup(name);
        if (ref.kind === "local")
            this.emit("LOCAL_SET", ref.a);
        else if (ref.kind === "up")
            this.emit("UP_SET", ref.a);
        else
            this.emit("GLOBAL_SET", ref.a);
    }
    statement(s) {
        switch (s.kind) {
            case "Local": {
                this.pushValues(s.values, s.names.length);
                const slots = s.names.map((n) => this.declareLocal(n));
                for (let i = slots.length - 1; i >= 0; i--)
                    this.emit("DECL", slots[i]);
                return;
            }
            case "LocalFunction": {
                // Se declara antes de compilar el cuerpo para que la función pueda llamarse a sí misma.
                const slot = this.declareLocal(s.name);
                this.emit("CONST", this.constIndex(null));
                this.emit("DECL", slot);
                const proto = this.functionProto(s.fn.params, s.fn.body, s.fn.isVararg, s.line);
                this.emit("CLOSURE", proto);
                this.emit("LOCAL_SET", slot);
                return;
            }
            case "FunctionDecl": {
                if (s.target.kind === "Name") {
                    const proto = this.functionProto(s.fn.params, s.fn.body, s.fn.isVararg, s.line);
                    this.emit("CLOSURE", proto);
                    this.storeName(s.target.name);
                    return;
                }
                if (s.target.kind === "Index") {
                    this.expr(s.target.object);
                    this.expr(s.target.key);
                    const proto = this.functionProto(s.fn.params, s.fn.body, s.fn.isVararg, s.line);
                    this.emit("CLOSURE", proto);
                    this.emit("SETINDEX");
                    return;
                }
                throw new CompileError("declaración de función no válida", s.line);
            }
            case "Assign": {
                // Primero se evalúan los objetos y claves de los destinos, luego los valores.
                const prepared = s.targets.map((t) => {
                    if (t.kind === "Name")
                        return {};
                    if (t.kind !== "Index")
                        throw new CompileError("no se puede asignar a esta expresión", s.line);
                    this.expr(t.object);
                    const obj = this.newTemp();
                    this.emit("DECL", obj);
                    this.expr(t.key);
                    const key = this.newTemp();
                    this.emit("DECL", key);
                    return { obj, key };
                });
                this.pushValues(s.values, s.targets.length);
                for (let i = s.targets.length - 1; i >= 0; i--) {
                    const t = s.targets[i];
                    const p = prepared[i];
                    if (t.kind === "Name") {
                        this.storeName(t.name);
                        continue;
                    }
                    // El valor queda en la cima: lo guardamos y luego llamamos a SETINDEX con [obj, clave, valor].
                    const val = this.newTemp();
                    this.emit("DECL", val);
                    this.emit("LOCAL_GET", p.obj);
                    this.emit("LOCAL_GET", p.key);
                    this.emit("LOCAL_GET", val);
                    this.emit("SETINDEX");
                }
                return;
            }
            case "CallStmt":
                this.expr(s.call);
                this.emit("POP");
                return;
            case "Do":
                this.block(s.body);
                return;
            case "While": {
                const start = this.here();
                this.expr(s.cond);
                const exit = this.emit("JMPF", -1);
                this.fn.loops.push([]);
                this.block(s.body);
                this.emit("JMP", start);
                this.finishLoop(exit);
                return;
            }
            case "Repeat": {
                // El cuerpo y la condición comparten ámbito, como en Lua.
                const start = this.here();
                this.fn.scopes.push(new Map());
                this.fn.loops.push([]);
                for (const st of s.body)
                    this.statement(st);
                this.expr(s.cond);
                this.emit("JMPF", start);
                this.fn.scopes.pop();
                const breaks = this.fn.loops.pop();
                for (const b of breaks)
                    this.patch(b, this.here());
                return;
            }
            case "If": {
                const endJumps = [];
                for (const clause of s.clauses) {
                    this.expr(clause.cond);
                    const skip = this.emit("JMPF", -1);
                    this.block(clause.body);
                    endJumps.push(this.emit("JMP", -1));
                    this.patch(skip, this.here());
                }
                if (s.orElse)
                    this.block(s.orElse);
                for (const j of endJumps)
                    this.patch(j, this.here());
                return;
            }
            case "NumericFor": {
                const step = s.step;
                const negative = step?.kind === "Unary" && step.op === "-" && step.operand.kind === "Number";
                if (step && !(step.kind === "Number" || negative)) {
                    throw new CompileError("el paso del for debe ser una constante numérica", s.line);
                }
                this.fn.scopes.push(new Map());
                this.expr(s.start);
                const iSlot = this.newTemp();
                this.emit("DECL", iSlot);
                this.expr(s.limit);
                const limSlot = this.newTemp();
                this.emit("DECL", limSlot);
                this.emit("CONST", this.constIndex(step ? this.numericValue(step) : 1));
                const stepSlot = this.newTemp();
                this.emit("DECL", stepSlot);
                const start = this.here();
                this.emit("LOCAL_GET", iSlot);
                this.emit("LOCAL_GET", limSlot);
                this.emit("BIN", this.opIndex(negative ? ">=" : "<="));
                const exit = this.emit("JMPF", -1);
                this.fn.loops.push([]);
                this.fn.scopes.push(new Map());
                // La variable de control es nueva en cada vuelta (importa para closures).
                const varSlot = this.declareLocal(s.name);
                this.emit("LOCAL_GET", iSlot);
                this.emit("DECL", varSlot);
                this.block(s.body, false);
                this.fn.scopes.pop();
                this.emit("LOCAL_GET", iSlot);
                this.emit("LOCAL_GET", stepSlot);
                this.emit("BIN", this.opIndex("+"));
                this.emit("LOCAL_SET", iSlot);
                this.emit("JMP", start);
                this.finishLoop(exit);
                this.fn.scopes.pop();
                return;
            }
            case "GenericFor":
                throw new CompileError("for genérico todavía no soportado (requiere retornos múltiples)", s.line);
            case "Return":
                if (s.values.length > 1)
                    throw new CompileError("solo se soporta un valor de retorno por ahora", s.line);
                if (s.values.length === 0)
                    this.emit("CONST", this.constIndex(null));
                else
                    this.expr(s.values[0]);
                this.emit("RET");
                return;
            case "Break": {
                const loop = this.fn.loops[this.fn.loops.length - 1];
                if (!loop)
                    throw new CompileError("'break' fuera de un bucle", s.line);
                loop.push(this.emit("JMP", -1));
                return;
            }
        }
    }
    finishLoop(exit) {
        this.patch(exit, this.here());
        const breaks = this.fn.loops.pop();
        for (const b of breaks)
            this.patch(b, this.here());
    }
    numericValue(e) {
        if (e.kind === "Number")
            return e.value;
        if (e.kind === "Unary" && e.op === "-" && e.operand.kind === "Number")
            return -e.operand.value;
        throw new CompileError("se esperaba una constante numérica");
    }
    // Empuja exactamente `count` valores, rellenando con nil o descartando sobrantes.
    pushValues(values, count) {
        values.forEach((v, i) => {
            this.expr(v);
            if (i >= count)
                this.emit("POP");
        });
        for (let i = values.length; i < count; i++)
            this.emit("CONST", this.constIndex(null));
    }
    expr(e) {
        switch (e.kind) {
            case "Nil":
                this.emit("CONST", this.constIndex(null));
                return;
            case "True":
                this.emit("CONST", this.constIndex(true));
                return;
            case "False":
                this.emit("CONST", this.constIndex(false));
                return;
            case "Number":
            case "String":
                this.emit("CONST", this.constIndex(e.value));
                return;
            case "Vararg":
                throw new CompileError("varargs (...) todavía no soportados");
            case "Name": {
                const ref = this.lookup(e.name);
                if (ref.kind === "local")
                    this.emit("LOCAL_GET", ref.a);
                else if (ref.kind === "up")
                    this.emit("UP_GET", ref.a);
                else
                    this.emit("GLOBAL_GET", ref.a);
                return;
            }
            case "Index":
                this.expr(e.object);
                this.expr(e.key);
                this.emit("INDEX");
                return;
            case "Paren":
                this.expr(e.expr);
                return;
            case "Unary":
                this.expr(e.operand);
                this.emit("UN", this.opIndex(e.op));
                return;
            case "Binary":
                if (e.op === "and" || e.op === "or") {
                    // Cortocircuito: si el izquierdo decide, se queda en la pila.
                    this.expr(e.left);
                    this.emit("DUP");
                    const jump = this.emit(e.op === "and" ? "JMPF" : "JMPT", -1);
                    this.emit("POP");
                    this.expr(e.right);
                    this.patch(jump, this.here());
                    return;
                }
                this.expr(e.left);
                this.expr(e.right);
                this.emit("BIN", this.opIndex(e.op));
                return;
            case "Call":
                this.expr(e.callee);
                for (const a of e.args)
                    this.expr(a);
                this.emit("CALL", e.args.length);
                return;
            case "MethodCall":
                // obj:m(args) == obj.m(obj, args)
                this.expr(e.object);
                this.emit("DUP");
                this.emit("CONST", this.constIndex(e.method));
                this.emit("INDEX");
                this.emit("SWAP");
                for (const a of e.args)
                    this.expr(a);
                this.emit("CALL", e.args.length + 1);
                return;
            case "Function": {
                const proto = this.functionProto(e.params, e.body, e.isVararg, e.line);
                this.emit("CLOSURE", proto);
                return;
            }
            case "Table": {
                this.emit("NEWTABLE");
                let position = 1;
                for (const item of e.items) {
                    this.emit("DUP");
                    if (item.kind === "Positional") {
                        this.emit("CONST", this.constIndex(position++));
                        this.expr(item.value);
                    }
                    else if (item.kind === "Named") {
                        this.emit("CONST", this.constIndex(item.key));
                        this.expr(item.value);
                    }
                    else {
                        this.expr(item.key);
                        this.expr(item.value);
                    }
                    this.emit("SETINDEX");
                }
                return;
            }
        }
        throw new CompileError(`expresión no soportada: ${e.kind}`);
    }
}
