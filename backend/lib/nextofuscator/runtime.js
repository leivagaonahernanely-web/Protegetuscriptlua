// Runtime de la VM en Lua 5.1, incrustado en cada archivo de salida junto con el bytecode.
// Sin límite de pasos: los scripts del cliente pueden ejecutarse indefinidamente.
// Replica la semántica de la VM de referencia (vm.ts). Rendimiento:
// - Al cargar, el bytecode se resuelve una vez: el tipo de instrucción pasa a ser un entero y
//   los argumentos (constantes, globales, funciones de operador, destinos de salto) ya vienen
//   listos, así que el bucle no hace búsquedas.
// - El despacho es un árbol binario de comparaciones (≈6 comparaciones por instrucción).
// - Las locales son valores directos; solo las capturadas por closures viven en una caja {v=...}.
// - Aritmética y comparación tienen camino rápido para números.
export const RUNTIME_LUA = `local function nx_run(P)
  local protos, consts, names = P.protos, P.consts, P.names
  local opnames, bopnames = P.opnames, P.ops
  -- Descifrado de cadenas (ver emit.ts): byte - clave - salt, módulo 256. Mismos salts que SALT.
  local KEYB, KN = P.k, #P.k
  local string_byte, string_char = string.byte, string.char
  local function decstr(s, salt)
    local out = {}
    for i = 1, #s do
      out[i] = string_char((string_byte(s, i) - KEYB[(i - 1) % KN + 1] - salt) % 256)
    end
    return table.concat(out)
  end
  for i = 1, #opnames do opnames[i] = decstr(opnames[i], 4000000 + i) end
  for i = 1, #bopnames do bopnames[i] = decstr(bopnames[i], 1000000 + i) end
  for i = 1, #names do names[i] = decstr(names[i], 2000000 + i) end
  for i = 1, P.nconsts do
    if type(consts[i]) == "string" then consts[i] = decstr(consts[i], 3000000 + i) end
  end
  -- Globales del script: en Roblox, _G no contiene game, Enum, Color3, task... (solo el entorno
  -- del script los tiene). getfenv() devuelve ese entorno; en Lua 5.1 estándar es _G.
  local env = (type(getfenv) == "function" and getfenv()) or _G
  local unpack = unpack or table.unpack
  local fmt = string.format
  local MAX_DEPTH = 1000
  local depth = 0
  local run_proto

  local function fail(msg) error(msg, 0) end

  local function typename(v)
    if v == nil then return "nil" end
    return type(v)
  end

  local function num(v, what)
    if type(v) ~= "number" then
      fail("intento de " .. what .. " sobre un valor de tipo " .. typename(v))
    end
    return v
  end

  local function tostr(v)
    local t = type(v)
    if t == "string" then return v end
    if t == "number" then return fmt("%.14g", v) end
    if v == nil then return "nil" end
    return tostring(v)
  end

  local function concatpart(v)
    if type(v) == "string" or type(v) == "number" then return tostr(v) end
    fail("intento de concatenar un valor de tipo " .. typename(v))
  end

  local function index(obj, key)
    if type(obj) == "table" then return obj[key] end
    if type(obj) == "string" then
      local lib = env.string
      if type(lib) == "table" then return lib[key] end
      return nil
    end
    fail("intento de indexar un valor de tipo " .. typename(obj))
  end

  local function setindex(obj, key, value)
    if type(obj) ~= "table" then
      fail("intento de asignar a un valor de tipo " .. typename(obj))
    end
    if key == nil then fail("índice nil") end
    if key ~= key then fail("índice NaN") end
    obj[key] = value
  end

  -- Una tabla con __call en su metatabla es invocable, igual que en Lua real (que resuelve
  -- la llamada por su cuenta una vez pasa este chequeo).
  local function is_callable(v)
    if type(v) == "function" then return true end
    if type(v) == "table" then
      local mt = getmetatable(v)
      return mt ~= nil and mt.__call ~= nil
    end
    return false
  end

  -- Operadores nativos sin verificar: delegan en Lua real, que ya resuelve metamétodos
  -- (__add, __lt, __concat, etc.) por su cuenta. Solo se usan cuando hay una tabla de por
  -- medio (camino lento), nunca en el camino rápido numérico.
  local native_bin = {
    ["+"] = function(l, r) return l + r end,
    ["-"] = function(l, r) return l - r end,
    ["*"] = function(l, r) return l * r end,
    ["/"] = function(l, r) return l / r end,
    ["%"] = function(l, r) return l % r end,
    ["^"] = function(l, r) return l ^ r end,
    [".."] = function(l, r) return l .. r end,
    ["<"] = function(l, r) return l < r end,
    ["<="] = function(l, r) return l <= r end,
    [">"] = function(l, r) return l > r end,
    [">="] = function(l, r) return l >= r end,
  }

  -- Intenta el metamétodo correspondiente (vía el operador nativo de Lua) cuando algún
  -- operando es tabla; si no hay metamétodo, Lua lanza su propio error y caemos al mensaje
  -- propio más abajo.
  local function try_meta(opname, l, r)
    if type(l) == "table" or type(r) == "table" then
      local ok, res = pcall(native_bin[opname], l, r)
      if ok then return true, res end
    end
    return false, nil
  end

  local cmp_check
  local binary_impl = {
    ["+"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then return l + r end
      local ok, res = try_meta("+", l, r); if ok then return res end
      return num(l, "sumar") + num(r, "sumar")
    end,
    ["-"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then return l - r end
      local ok, res = try_meta("-", l, r); if ok then return res end
      return num(l, "restar") - num(r, "restar")
    end,
    ["*"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then return l * r end
      local ok, res = try_meta("*", l, r); if ok then return res end
      return num(l, "multiplicar") * num(r, "multiplicar")
    end,
    ["/"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then return l / r end
      local ok, res = try_meta("/", l, r); if ok then return res end
      return num(l, "dividir") / num(r, "dividir")
    end,
    ["%"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then
        return l - math.floor(l / r) * r
      end
      local ok, res = try_meta("%", l, r); if ok then return res end
      local a, b = num(l, "calcular módulo"), num(r, "calcular módulo")
      return a - math.floor(a / b) * b
    end,
    ["^"] = function(l, r)
      if type(l) == "number" and type(r) == "number" then return l ^ r end
      local ok, res = try_meta("^", l, r); if ok then return res end
      return num(l, "elevar") ^ num(r, "elevar")
    end,
    ["//"] = function(l, r)
      -- División entera de Luau: redondea hacia -infinito.
      if type(l) == "number" and type(r) == "number" then return math.floor(l / r) end
      return math.floor(num(l, "dividir") / num(r, "dividir"))
    end,
    [".."] = function(l, r)
      if (type(l) == "string" or type(l) == "number") and (type(r) == "string" or type(r) == "number") then
        return concatpart(l) .. concatpart(r)
      end
      local ok, res = try_meta("..", l, r); if ok then return res end
      return concatpart(l) .. concatpart(r)
    end,
    ["=="] = function(l, r) return l == r end,
    ["~="] = function(l, r) return l ~= r end,
    ["<"] = function(l, r)
      if cmp_check(l, r) then return l < r end
      local ok, res = try_meta("<", l, r); if ok then return res end
      fail("no se puede comparar " .. typename(l) .. " con " .. typename(r))
    end,
    ["<="] = function(l, r)
      if cmp_check(l, r) then return l <= r end
      local ok, res = try_meta("<=", l, r); if ok then return res end
      fail("no se puede comparar " .. typename(l) .. " con " .. typename(r))
    end,
    [">"] = function(l, r)
      if cmp_check(l, r) then return l > r end
      local ok, res = try_meta(">", l, r); if ok then return res end
      fail("no se puede comparar " .. typename(l) .. " con " .. typename(r))
    end,
    [">="] = function(l, r)
      if cmp_check(l, r) then return l >= r end
      local ok, res = try_meta(">=", l, r); if ok then return res end
      fail("no se puede comparar " .. typename(l) .. " con " .. typename(r))
    end,
  }

  -- true/false en vez de fail(): el camino lento decide si intenta un metamétodo antes
  -- de fallar con el mensaje propio.
  cmp_check = function(l, r)
    local tl, tr = type(l), type(r)
    return tl == tr and (tl == "number" or tl == "string")
  end

  local unary_impl = {
    ["-"] = function(v)
      if type(v) == "number" then return -v end
      if type(v) == "table" then
        local ok, res = pcall(function(x) return -x end, v)
        if ok then return res end
      end
      return -num(v, "negar")
    end,
    ["not"] = function(v) return v == nil or v == false end,
    ["#"] = function(v)
      if type(v) == "string" then return string.len(v) end
      -- Operador nativo de Lua: O(log n) y ya respeta __len. Un bucle manual sobre t[n+1]
      -- hacía t[#t+1]=x cuadrático.
      if type(v) == "table" then return #v end
      fail("intento de obtener longitud de un valor de tipo " .. typename(v))
    end,
  }

  local bfn, ufn = {}, {}
  for i = 1, #bopnames do
    bfn[i] = binary_impl[bopnames[i]]
    ufn[i] = unary_impl[bopnames[i]]
  end

  -- Tipos de instrucción resueltos al cargar. Enteros: comparar enteros es más barato que strings.
  local K = {
    LGET = 1, CONST = 2, ADD = 3, SUB = 4, LT = 5, LE = 6, GT = 7, GE = 8, EQ = 9, NE = 10,
    MUL = 11, CALL = 12, LSET = 13, JMPF = 14, BGET = 15, BSET = 16, BDECL = 17, DECL = 18,
    POP = 19, RET = 20, BIN = 21, GGET = 22, GSET = 23, DUP = 24, SWAP = 25, UPGET = 26,
    UPSET = 27, UN = 28, JMPT = 29, CLOSURE = 30, NEWTABLE = 31, JMP = 32, INDEX = 33, SETINDEX = 34,
    CALLM = 35, CALLV = 36, CALLVM = 37, ADJ = 38, ADDCOUNT = 39, RETV = 40, VARARG = 41, VARARG1 = 42,
    SETLIST = 43,
  }
  local fast = {
    ["+"] = K.ADD, ["-"] = K.SUB, ["*"] = K.MUL, ["<"] = K.LT, ["<="] = K.LE,
    [">"] = K.GT, [">="] = K.GE, ["=="] = K.EQ, ["~="] = K.NE,
  }

  -- Reescribe un código plano [tipo, argumento, ...] con argumentos ya resueltos.
  -- Saltos: destino plano (a * 2 + 1). Constantes, globales y operadores: el valor o la función.
  local function resolve(code)
    local n = #code
    for pc = 1, n, 2 do
      local name = opnames[code[pc] + 1]
      local a = code[pc + 1]
      local kind, arg = nil, a
      if name == "LOCAL_GET" then kind = K.LGET
      elseif name == "CONST" then kind, arg = K.CONST, consts[a + 1]
      elseif name == "BIN" then
        local op = bopnames[a + 1]
        kind, arg = fast[op] or K.BIN, bfn[a + 1]
      elseif name == "CALL" then kind = K.CALL
      elseif name == "LOCAL_SET" then kind = K.LSET
      elseif name == "JMPF" then kind, arg = K.JMPF, a * 2 + 1
      elseif name == "JMPT" then kind, arg = K.JMPT, a * 2 + 1
      elseif name == "JMP" then kind, arg = K.JMP, a * 2 + 1
      elseif name == "INDEX" then kind = K.INDEX
      elseif name == "SETINDEX" then kind = K.SETINDEX
      elseif name == "DECL" then kind = K.DECL
      elseif name == "BOX_GET" then kind = K.BGET
      elseif name == "BOX_SET" then kind = K.BSET
      elseif name == "BOX_DECL" then kind = K.BDECL
      elseif name == "POP" then kind = K.POP
      elseif name == "RET" then kind = K.RET
      elseif name == "GLOBAL_GET" then kind, arg = K.GGET, names[a + 1]
      elseif name == "GLOBAL_SET" then kind, arg = K.GSET, names[a + 1]
      elseif name == "DUP" then kind = K.DUP
      elseif name == "SWAP" then kind = K.SWAP
      elseif name == "UP_GET" then kind, arg = K.UPGET, a + 1
      elseif name == "UP_SET" then kind, arg = K.UPSET, a + 1
      elseif name == "UN" then kind, arg = K.UN, ufn[a + 1]
      elseif name == "CLOSURE" then kind, arg = K.CLOSURE, protos[a + 1]
      elseif name == "NEWTABLE" then kind = K.NEWTABLE
      elseif name == "CALLM" then kind, arg = K.CALLM, a
      elseif name == "CALLV" then kind = K.CALLV
      elseif name == "CALLVM" then kind = K.CALLVM
      elseif name == "ADJ" then kind, arg = K.ADJ, a
      elseif name == "ADDCOUNT" then kind, arg = K.ADDCOUNT, a
      elseif name == "RETV" then kind = K.RETV
      elseif name == "VARARG" then kind = K.VARARG
      elseif name == "VARARG1" then kind = K.VARARG1
      elseif name == "SETLIST" then kind = K.SETLIST
      else fail("operación desconocida") end
      code[pc], code[pc + 1] = kind, arg
    end
  end

  local function make_closure(proto, ups)
    return function(...)
      return run_proto(proto, ups, { ... }, select("#", ...))
    end
  end

  -- Empaqueta resultados de una llamada con su cantidad (los nil también cuentan).
  local function pack(...)
    return { n = select("#", ...), ... }
  end

  local NO_VARARGS = { n = 0 }

  run_proto = function(proto, ups, args, nargs)
    -- La profundidad de este marco se deriva de quien llama (CALL la fija antes de llamar),
    -- no de un contador global: así un error capturado con pcall no deja la cuenta inflada.
    local myd = depth + 1
    if myd > MAX_DEPTH then fail("desbordamiento de la pila de llamadas") end
    depth = myd

    local code = proto.code
    -- Celdas de locales: valor directo, salvo las capturadas por closures (cajas {v=...}).
    local cells = {}
    for i = 1, proto.params do cells[i] = args[i] end
    local bp = proto.bp
    for j = 1, #bp do
      local s = bp[j]
      cells[s] = { v = cells[s] }
    end

    -- Argumentos extra ('...'): se leen directamente de args desde vo + j, sin copiarlos.
    -- Sin extras se usa una tabla vacía y vn = 0.
    local va, vn, vo = NO_VARARGS, 0, 0
    if nargs > proto.params then
      va, vn, vo = args, nargs - proto.params, proto.params
    end

    local stack, sp = {}, 0
    local pc = 1

    while true do
      local op = code[pc]
      local a = code[pc + 1]
      pc = pc + 2

      -- Las instrucciones más frecuentes se comprueban primero (LGET, CONST, ADD): así no
      -- recorren el árbol binario de abajo, que cuesta ~6 comparaciones por instrucción.
      if op == 1 then -- LGET
        sp = sp + 1
        stack[sp] = cells[a]
      elseif op == 2 then -- CONST
        sp = sp + 1
        stack[sp] = a
      elseif op == 3 then -- ADD
        local l, r = stack[sp - 1], stack[sp]
        if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l + r
        else stack[sp - 1] = a(l, r) end
        sp = sp - 1
      elseif op <= 17 then
        if op <= 9 then
          if op <= 5 then
            if op <= 3 then
              -- (1, 2 y 3 ya se atendieron arriba)
            else
              if op == 4 then -- SUB
                local l, r = stack[sp - 1], stack[sp]
                if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l - r
                else stack[sp - 1] = a(l, r) end
                sp = sp - 1
              elseif op == 5 then -- LT
                local l, r = stack[sp - 1], stack[sp]
                if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l < r
                else stack[sp - 1] = a(l, r) end
                sp = sp - 1
              end
            end
          else
            if op <= 7 then
              if op == 6 then -- LE
                local l, r = stack[sp - 1], stack[sp]
                if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l <= r
                else stack[sp - 1] = a(l, r) end
                sp = sp - 1
              else -- GT (7)
                local l, r = stack[sp - 1], stack[sp]
                if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l > r
                else stack[sp - 1] = a(l, r) end
                sp = sp - 1
              end
            elseif op == 8 then -- GE
              local l, r = stack[sp - 1], stack[sp]
              if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l >= r
              else stack[sp - 1] = a(l, r) end
              sp = sp - 1
            else -- EQ (9)
              stack[sp - 1] = stack[sp - 1] == stack[sp]
              sp = sp - 1
            end
          end
        else
          if op <= 13 then
            if op == 10 then -- NE
              stack[sp - 1] = stack[sp - 1] ~= stack[sp]
              sp = sp - 1
            elseif op == 11 then -- MUL
              local l, r = stack[sp - 1], stack[sp]
              if type(l) == "number" and type(r) == "number" then stack[sp - 1] = l * r
              else stack[sp - 1] = a(l, r) end
              sp = sp - 1
            elseif op == 12 then -- CALL
              local callee = stack[sp - a]
              if not is_callable(callee) then
                fail("se intentó llamar a un valor de tipo " .. typename(callee))
              end
              depth = myd
              local r = callee(unpack(stack, sp - a + 1, sp))
              sp = sp - a
              stack[sp] = r
            else -- LSET (13)
              cells[a] = stack[sp]
              sp = sp - 1
            end
          else
            if op == 14 then -- JMPF
              local v = stack[sp]
              sp = sp - 1
              if v == nil or v == false then pc = a end
            elseif op == 15 then -- BGET
              sp = sp + 1
              stack[sp] = cells[a].v
            elseif op == 16 then -- BSET
              cells[a].v = stack[sp]
              sp = sp - 1
            else -- BDECL (17)
              cells[a] = { v = stack[sp] }
              sp = sp - 1
            end
          end
        end
      else
        if op <= 26 then
          if op <= 22 then
            if op <= 20 then
              if op == 18 then -- DECL
                cells[a] = stack[sp]
                sp = sp - 1
              elseif op == 19 then -- POP
                sp = sp - 1
              else -- RET (20)
                depth = myd - 1
                return stack[sp]
              end
            else
              if op == 21 then -- BIN (general)
                stack[sp - 1] = a(stack[sp - 1], stack[sp])
                sp = sp - 1
              else -- GGET (22)
                sp = sp + 1
                stack[sp] = env[a]
              end
            end
          else
            if op <= 24 then
              if op == 23 then -- GSET
                env[a] = stack[sp]
                sp = sp - 1
              else -- DUP (24)
                sp = sp + 1
                stack[sp] = stack[sp - 1]
              end
            else
              if op == 25 then -- SWAP
                stack[sp], stack[sp - 1] = stack[sp - 1], stack[sp]
              else -- UPGET (26)
                sp = sp + 1
                stack[sp] = ups[a].v
              end
            end
          end
        else
          if op <= 30 then
            if op == 27 then -- UPSET
              ups[a].v = stack[sp]
              sp = sp - 1
            elseif op == 28 then -- UN
              stack[sp] = a(stack[sp])
            elseif op == 29 then -- JMPT
              local v = stack[sp]
              sp = sp - 1
              if v ~= nil and v ~= false then pc = a end
            else -- CLOSURE (30): a = prototipo hijo
              local cup = a.up
              local child_ups = {}
              for i = 1, #cup do
                local d = cup[i]
                if d[1] == 1 then child_ups[i] = cells[d[2]]
                else child_ups[i] = ups[d[2] + 1] end
              end
              sp = sp + 1
              stack[sp] = make_closure(a, child_ups)
            end
          else
            if op == 31 then -- NEWTABLE
              sp = sp + 1
              stack[sp] = {}
            elseif op == 32 then -- JMP
              pc = a
            elseif op == 33 then -- INDEX
              stack[sp - 1] = index(stack[sp - 1], stack[sp])
              sp = sp - 1
            elseif op == 34 then -- SETINDEX
              setindex(stack[sp - 2], stack[sp - 1], stack[sp])
              sp = sp - 3
            elseif op == 35 then -- CALLM: args fijos, resultados variables (callee en sp - a)
              local callee = stack[sp - a]
              if not is_callable(callee) then
                fail("se intentó llamar a un valor de tipo " .. typename(callee))
              end
              depth = myd
              local res = pack(callee(unpack(stack, sp - a + 1, sp)))
              sp = sp - a - 1
              for j = 1, res.n do
                sp = sp + 1
                stack[sp] = res[j]
              end
              sp = sp + 1
              stack[sp] = res.n
            elseif op == 36 then -- CALLV: args variables, un resultado
              local k = stack[sp]
              sp = sp - 1
              local callee = stack[sp - k]
              if not is_callable(callee) then
                fail("se intentó llamar a un valor de tipo " .. typename(callee))
              end
              depth = myd
              local r = callee(unpack(stack, sp - k + 1, sp))
              sp = sp - k
              stack[sp] = r
            elseif op == 37 then -- CALLVM: args variables, resultados variables
              local k = stack[sp]
              sp = sp - 1
              local callee = stack[sp - k]
              if not is_callable(callee) then
                fail("se intentó llamar a un valor de tipo " .. typename(callee))
              end
              depth = myd
              local res = pack(callee(unpack(stack, sp - k + 1, sp)))
              sp = sp - k - 1
              for j = 1, res.n do
                sp = sp + 1
                stack[sp] = res[j]
              end
              sp = sp + 1
              stack[sp] = res.n
            elseif op == 38 then -- ADJ: deja exactamente a valores de la lista
              local k = stack[sp]
              sp = sp - 1
              local base = sp - k
              for j = 1, a do
                local v = nil
                if j <= k then v = stack[base + j] end
                stack[base + j] = v
              end
              sp = base + a
            elseif op == 39 then -- ADDCOUNT
              stack[sp] = stack[sp] + a
            elseif op == 40 then -- RETV: devuelve la lista
              local k = stack[sp]
              sp = sp - 1
              depth = myd - 1
              return unpack(stack, sp - k + 1, sp)
            elseif op == 41 then -- VARARG
              for j = 1, vn do
                sp = sp + 1
                stack[sp] = va[vo + j]
              end
              sp = sp + 1
              stack[sp] = vn
            elseif op == 42 then -- VARARG1
              sp = sp + 1
              stack[sp] = va[vo + 1]
            else -- SETLIST (43): [..., t, inicio, v1..vk, k]; consume el duplicado de t
              local k = stack[sp]
              sp = sp - 1
              local base = sp - k
              local start = stack[base]
              local t = stack[base - 1]
              for j = 1, k do setindex(t, start + j - 1, stack[base + j]) end
              sp = base - 2
            end
          end
        end
      end
    end
  end

  for i = 1, #protos do resolve(protos[i].code) end
  return run_proto(protos[1], {}, {}, 0)
end
`;
