// BOX_* son LOCAL_* para locales capturadas por closures: su celda es una caja {v=...}.
export const OP_NAMES = [
    "CONST", "LOCAL_GET", "LOCAL_SET", "DECL", "GLOBAL_GET", "GLOBAL_SET", "UP_GET", "UP_SET",
    "BIN", "UN", "JMP", "JMPF", "JMPT", "DUP", "POP", "SWAP", "CALL", "RET", "CLOSURE",
    "NEWTABLE", "INDEX", "SETINDEX", "BOX_GET", "BOX_SET", "BOX_DECL",
    // Listas de valores variables: la lista va seguida de su cantidad (el contador queda en la cima).
    // CALLM: llamada con argumentos fijos y resultados variables. CALLV/CALLVM: argumentos variables.
    // ADJ n: deja exactamente n valores. ADDCOUNT n: suma n a la cantidad. RETV: devuelve la lista.
    // VARARG/VARARG1: todos (o el primero) de los argumentos extra. SETLIST: llena una tabla.
    "CALLM", "CALLV", "CALLVM", "ADJ", "ADDCOUNT", "RETV", "VARARG", "VARARG1", "SETLIST",
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
const NEG_ZERO_KEY = Symbol("-0");
class Compiler {
    consts = [];
    names = [];
    ops = [];
    constMap = new Map();
    nameMap = new Map();
    opMap = new Map();
    protos = [];
    fns = [];
    compileMain(block) {
        // El fragmento principal de Lua es una función vararg.
        this.functionProto([], block, true);
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
        const index = this.protos.length;
        this.protos.push(null); // reserva el índice antes de compilar anidadas
        this.fns.push({
            // Los slots empiezan en 1: el runtime guarda las celdas en una tabla de array (1..n),
            // y el índice 0 caería en la parte hash, más lenta.
            code: [], scopes: [new Map()], slots: 1, loops: [], continues: [], upvals: [], upvalNames: new Map(),
            captured: new Set(), vararg: isVararg,
        });
        for (const p of params)
            this.declareLocal(p);
        this.block(body, false);
        this.emit("CONST", this.constIndex(null));
        this.emit("RET");
        const state = this.fns.pop();
        // Ahora que se conocen todas las capturas (las hijas ya están compiladas), se pasan a caja
        // las operaciones sobre locales capturadas. Cada variable tiene un slot único, así que esto
        // no afecta a otras variables.
        for (const instr of state.code) {
            if (!state.captured.has(instr.a ?? -1))
                continue;
            if (instr.op === "LOCAL_GET")
                instr.op = "BOX_GET";
            else if (instr.op === "LOCAL_SET")
                instr.op = "BOX_SET";
            else if (instr.op === "DECL")
                instr.op = "BOX_DECL";
        }
        // Los parámetros ocupan los slots 1..n (ver slots: 1 arriba).
        const boxedParams = [...Array(params.length).keys()].map((i) => i + 1).filter((s) => state.captured.has(s));
        this.protos[index] = { code: state.code, params: params.length, slots: state.slots, upvals: state.upvals, boxedParams };
        return index;
    }
    // Búsquedas en O(1) con Map: antes eran indexOf/findIndex lineales, cuadráticas en scripts grandes.
    // Map compara con SameValueZero, que trata +0 y -0 como iguales; Object.is (la semántica original)
    // no. Por eso -0 usa una clave reservada.
    constIndex(value) {
        const key = Object.is(value, -0) ? NEG_ZERO_KEY : value;
        const known = this.constMap.get(key);
        if (known !== undefined)
            return known;
        this.consts.push(value);
        this.constMap.set(key, this.consts.length - 1);
        return this.consts.length - 1;
    }
    nameIndex(name) {
        const known = this.nameMap.get(name);
        if (known !== undefined)
            return known;
        this.names.push(name);
        this.nameMap.set(name, this.names.length - 1);
        return this.names.length - 1;
    }
    opIndex(op) {
        const known = this.opMap.get(op);
        if (known !== undefined)
            return known;
        this.ops.push(op);
        this.opMap.set(op, this.ops.length - 1);
        return this.ops.length - 1;
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
            parent.captured.add(local);
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
                this.pushList(s.values, s.names.length);
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
                this.pushList(s.values, s.targets.length);
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
                this.fn.continues.push([]);
                this.block(s.body);
                for (const c of this.fn.continues.pop())
                    this.patch(c, start);
                this.emit("JMP", start);
                this.finishLoop(exit);
                return;
            }
            case "Repeat": {
                // El cuerpo y la condición comparten ámbito, como en Lua.
                const start = this.here();
                this.fn.scopes.push(new Map());
                this.fn.loops.push([]);
                this.fn.continues.push([]);
                for (const st of s.body)
                    this.statement(st);
                // 'continue' en un repeat salta a la condición.
                const condAt = this.here();
                for (const c of this.fn.continues.pop())
                    this.patch(c, condAt);
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
                // Con paso constante la comparación se elige al compilar; con paso variable se comprueba el signo en cada vuelta.
                const constStep = !step || step.kind === "Number" || negative;
                this.fn.scopes.push(new Map());
                this.expr(s.start);
                const iSlot = this.newTemp();
                this.emit("DECL", iSlot);
                this.expr(s.limit);
                const limSlot = this.newTemp();
                this.emit("DECL", limSlot);
                if (constStep)
                    this.emit("CONST", this.constIndex(step ? this.numericValue(step) : 1));
                else
                    this.expr(step);
                const stepSlot = this.newTemp();
                this.emit("DECL", stepSlot);
                const start = this.here();
                let exit;
                if (constStep) {
                    this.emit("LOCAL_GET", iSlot);
                    this.emit("LOCAL_GET", limSlot);
                    this.emit("BIN", this.opIndex(negative ? ">=" : "<="));
                    exit = this.emit("JMPF", -1);
                }
                else {
                    // Paso >= 0: sigue mientras i <= límite. Paso < 0: sigue mientras i >= límite.
                    this.emit("LOCAL_GET", stepSlot);
                    this.emit("CONST", this.constIndex(0));
                    this.emit("BIN", this.opIndex(">="));
                    const toNegative = this.emit("JMPF", -1);
                    this.emit("LOCAL_GET", iSlot);
                    this.emit("LOCAL_GET", limSlot);
                    this.emit("BIN", this.opIndex("<="));
                    const toCheck = this.emit("JMP", -1);
                    this.patch(toNegative, this.here());
                    this.emit("LOCAL_GET", iSlot);
                    this.emit("LOCAL_GET", limSlot);
                    this.emit("BIN", this.opIndex(">="));
                    this.patch(toCheck, this.here());
                    exit = this.emit("JMPF", -1);
                }
                this.fn.loops.push([]);
                this.fn.continues.push([]);
                this.fn.scopes.push(new Map());
                // La variable de control es nueva en cada vuelta (importa para closures).
                const varSlot = this.declareLocal(s.name);
                this.emit("LOCAL_GET", iSlot);
                this.emit("DECL", varSlot);
                this.block(s.body, false);
                this.fn.scopes.pop();
                // 'continue' en un for numérico salta al incremento.
                const incAt = this.here();
                for (const c of this.fn.continues.pop())
                    this.patch(c, incAt);
                this.emit("LOCAL_GET", iSlot);
                this.emit("LOCAL_GET", stepSlot);
                this.emit("BIN", this.opIndex("+"));
                this.emit("LOCAL_SET", iSlot);
                this.emit("JMP", start);
                this.finishLoop(exit);
                this.fn.scopes.pop();
                return;
            }
            case "GenericFor": {
                // f, estado y control se evalúan una vez. Cada vuelta llama f(estado, control), reparte los
                // resultados entre las variables y termina cuando la primera es nil.
                this.fn.scopes.push(new Map());
                this.pushList(s.iterators, 3);
                const control = this.newTemp();
                this.emit("DECL", control);
                const state = this.newTemp();
                this.emit("DECL", state);
                const iter = this.newTemp();
                this.emit("DECL", iter);
                const start = this.here();
                this.emit("LOCAL_GET", iter);
                this.emit("LOCAL_GET", state);
                this.emit("LOCAL_GET", control);
                this.emit("CALLM", 2);
                this.emit("ADJ", s.names.length);
                // Las variables del bucle son nuevas en cada vuelta (importa para closures).
                this.fn.scopes.push(new Map());
                const slots = s.names.map((n) => this.declareLocal(n));
                for (let i = slots.length - 1; i >= 0; i--)
                    this.emit("DECL", slots[i]);
                this.emit("LOCAL_GET", slots[0]);
                this.emit("CONST", this.constIndex(null));
                this.emit("BIN", this.opIndex("=="));
                const exit = this.emit("JMPT", -1);
                this.emit("LOCAL_GET", slots[0]);
                this.emit("LOCAL_SET", control);
                this.fn.loops.push([]);
                this.fn.continues.push([]);
                this.block(s.body, false);
                // 'continue' en un for genérico vuelve a llamar al iterador.
                for (const c of this.fn.continues.pop())
                    this.patch(c, start);
                this.emit("JMP", start);
                this.finishLoop(exit);
                this.fn.scopes.pop();
                this.fn.scopes.pop();
                return;
            }
            case "Return": {
                const values = s.values;
                if (values.length === 0) {
                    this.emit("CONST", this.constIndex(null));
                    this.emit("RET");
                }
                else if (values.length === 1 && !this.isMulti(values[0])) {
                    this.expr(values[0]);
                    this.emit("RET");
                }
                else if (values.length === 1) {
                    this.emitMulti(values[0]);
                    this.emit("RETV");
                }
                else {
                    this.pushVar(values);
                    this.emit("RETV");
                }
                return;
            }
            case "Break": {
                const loop = this.fn.loops[this.fn.loops.length - 1];
                if (!loop)
                    throw new CompileError("'break' fuera de un bucle", s.line);
                loop.push(this.emit("JMP", -1));
                return;
            }
            case "Continue": {
                const conts = this.fn.continues[this.fn.continues.length - 1];
                if (!conts)
                    throw new CompileError("'continue' fuera de un bucle", s.line);
                conts.push(this.emit("JMP", -1));
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
    // Expresiones que pueden dar varios valores: llamadas y '...'.
    isMulti(e) {
        return e.kind === "Call" || e.kind === "MethodCall" || e.kind === "Vararg";
    }
    // Deja todos los valores de una expresión multivalor seguidos de su cantidad.
    emitMulti(e) {
        if (e.kind === "Vararg") {
            if (!this.fn.vararg)
                throw new CompileError("no se puede usar '...' fuera de una función vararg");
            this.emit("VARARG");
            return;
        }
        this.emitCall(e, true);
    }
    // Empuja exactamente `want` valores para una lista de expresiones (asignación, local).
    // Solo la última expresión puede expandirse; las demás aportan un valor cada una.
    pushList(values, want) {
        const n = values.length;
        values.forEach((v, i) => {
            if (i === n - 1 && this.isMulti(v)) {
                this.emitMulti(v);
                this.emit("ADJ", Math.max(want - i, 0));
                return;
            }
            this.expr(v);
            if (i >= want)
                this.emit("POP");
        });
        if (n === 0 || !this.isMulti(values[n - 1])) {
            for (let i = n; i < want; i++)
                this.emit("CONST", this.constIndex(null));
        }
    }
    // Empuja todos los valores de una lista seguidos de su cantidad, con la cantidad en la cima.
    // Se usa cuando la lista tiene un tamaño que solo se conoce al ejecutar (argumentos, return).
    pushVar(values) {
        const n = values.length;
        values.forEach((v, i) => {
            if (i === n - 1 && this.isMulti(v)) {
                this.emitMulti(v);
                if (n > 1)
                    this.emit("ADDCOUNT", n - 1);
            }
            else {
                this.expr(v);
            }
        });
        if (n === 0 || !this.isMulti(values[n - 1]))
            this.emit("CONST", this.constIndex(n));
    }
    // Compila una llamada. Con multi=true deja todos los resultados y su cantidad en la pila.
    emitCall(e, multi) {
        let args;
        let hasSelf = false;
        if (e.kind === "Call") {
            this.expr(e.callee);
            args = e.args;
        }
        else if (e.kind === "MethodCall") {
            // obj:m(args) == obj.m(obj, args)
            this.expr(e.object);
            this.emit("DUP");
            this.emit("CONST", this.constIndex(e.method));
            this.emit("INDEX");
            this.emit("SWAP");
            args = e.args;
            hasSelf = true;
        }
        else {
            throw new CompileError("se esperaba una llamada");
        }
        if (args.length > 0 && this.isMulti(args[args.length - 1])) {
            this.pushVar(args);
            if (hasSelf)
                this.emit("ADDCOUNT", 1); // 'self' queda debajo de la lista variable
            this.emit(multi ? "CALLVM" : "CALLV");
        }
        else {
            for (const a of args)
                this.expr(a);
            this.emit(multi ? "CALLM" : "CALL", args.length + (hasSelf ? 1 : 0));
        }
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
                if (!this.fn.vararg)
                    throw new CompileError("no se puede usar '...' fuera de una función vararg");
                this.emit("VARARG1");
                return;
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
            case "MethodCall":
                // En contexto de un solo valor: la llamada se queda con el primer resultado.
                this.emitCall(e, false);
                return;
            case "IfExpr": {
                // Luau: if c then a elseif d then b else e. Solo se evalúa la rama que corresponde.
                const endJumps = [];
                for (const clause of e.clauses) {
                    this.expr(clause.cond);
                    const skip = this.emit("JMPF", -1);
                    this.expr(clause.value);
                    endJumps.push(this.emit("JMP", -1));
                    this.patch(skip, this.here());
                }
                this.expr(e.orElse);
                for (const j of endJumps)
                    this.patch(j, this.here());
                return;
            }
            case "Function": {
                const proto = this.functionProto(e.params, e.body, e.isVararg, e.line);
                this.emit("CLOSURE", proto);
                return;
            }
            case "Table": {
                this.emit("NEWTABLE");
                let position = 1;
                const lastIndex = e.items.length - 1;
                for (const [idx, item] of e.items.entries()) {
                    // Último elemento posicional multivalor: se expande dentro de la tabla.
                    if (idx === lastIndex && item.kind === "Positional" && this.isMulti(item.value)) {
                        this.emit("DUP");
                        this.emit("CONST", this.constIndex(position));
                        this.emitMulti(item.value);
                        this.emit("SETLIST");
                        return;
                    }
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
