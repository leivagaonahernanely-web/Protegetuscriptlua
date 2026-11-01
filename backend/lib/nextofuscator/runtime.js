// Runtime de la VM en Lua 5.1, incrustado en cada archivo de salida junto con el bytecode.
// Sin límite de pasos: los scripts del cliente pueden ejecutarse indefinidamente.
// Replica la semántica de la VM de referencia (vm.ts), pero optimizado para velocidad:
// operadores resueltos una sola vez al cargar, pila con puntero y sin closures por frame.
export const RUNTIME_LUA = `local function nx_run(P)
  local protos, consts, names = P.protos, P.consts, P.names
  local opnames, bopnames = P.opnames, P.ops
  local env = _G
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

  local cmp_check
  local binary_impl = {
    ["+"] = function(l, r) return num(l, "sumar") + num(r, "sumar") end,
    ["-"] = function(l, r) return num(l, "restar") - num(r, "restar") end,
    ["*"] = function(l, r) return num(l, "multiplicar") * num(r, "multiplicar") end,
    ["/"] = function(l, r) return num(l, "dividir") / num(r, "dividir") end,
    ["%"] = function(l, r)
      local a, b = num(l, "calcular módulo"), num(r, "calcular módulo")
      return a - math.floor(a / b) * b
    end,
    ["^"] = function(l, r) return num(l, "elevar") ^ num(r, "elevar") end,
    [".."] = function(l, r) return concatpart(l) .. concatpart(r) end,
    ["=="] = function(l, r) return l == r end,
    ["~="] = function(l, r) return l ~= r end,
    ["<"] = function(l, r) return cmp_check(l, r) and l < r end,
    ["<="] = function(l, r) return cmp_check(l, r) and l <= r end,
    [">"] = function(l, r) return cmp_check(l, r) and l > r end,
    [">="] = function(l, r) return cmp_check(l, r) and l >= r end,
  }

  cmp_check = function(l, r)
    local tl, tr = type(l), type(r)
    if tl ~= tr or (tl ~= "number" and tl ~= "string") then
      fail("no se puede comparar " .. typename(l) .. " con " .. typename(r))
    end
    return true
  end

  local unary_impl = {
    ["-"] = function(v) return -num(v, "negar") end,
    ["not"] = function(v) return v == nil or v == false end,
    ["#"] = function(v)
      if type(v) == "string" then return string.len(v) end
      if type(v) == "table" then
        local n = 0
        while v[n + 1] ~= nil do n = n + 1 end
        return n
      end
      fail("intento de obtener longitud de un valor de tipo " .. typename(v))
    end,
  }

  -- Resuelve cada operador una sola vez, en lugar de compararlo en cada ejecución.
  local bfn, ufn = {}, {}
  for i = 1, #bopnames do
    bfn[i] = binary_impl[bopnames[i]]
    ufn[i] = unary_impl[bopnames[i]]
  end

  local function make_closure(index_, ups)
    local proto = protos[index_]
    return function(...)
      return run_proto(proto, ups, { ... }, select("#", ...))
    end
  end

  run_proto = function(proto, ups, args, nargs)
    depth = depth + 1
    if depth > MAX_DEPTH then fail("desbordamiento de la pila de llamadas") end

    local code = proto.code
    -- Las celdas se crean al declarar cada local (DECL); solo los parámetros se crean aquí.
    local cells = {}
    for i = 0, proto.params - 1 do cells[i] = { v = args[i + 1] } end

    local stack, sp = {}, 0
    local pc = 1 -- índice plano: código[pc] = operación, código[pc + 1] = argumento

    while true do
      local op = opnames[code[pc] + 1]
      local a = code[pc + 1]
      pc = pc + 2

      if op == "LOCAL_GET" then
        sp = sp + 1
        stack[sp] = cells[a].v
      elseif op == "CONST" then
        sp = sp + 1
        stack[sp] = consts[a + 1]
      elseif op == "BIN" then
        stack[sp - 1] = bfn[a + 1](stack[sp - 1], stack[sp])
        sp = sp - 1
      elseif op == "CALL" then
        local callee = stack[sp - a]
        if type(callee) ~= "function" then
          fail("se intentó llamar a un valor de tipo " .. typename(callee))
        end
        local r = callee(unpack(stack, sp - a + 1, sp))
        sp = sp - a
        stack[sp] = r
      elseif op == "LOCAL_SET" then
        cells[a].v = stack[sp]
        sp = sp - 1
      elseif op == "JMPF" then
        local v = stack[sp]
        sp = sp - 1
        if v == nil or v == false then pc = a * 2 + 1 end
      elseif op == "INDEX" then
        stack[sp - 1] = index(stack[sp - 1], stack[sp])
        sp = sp - 1
      elseif op == "SETINDEX" then
        setindex(stack[sp - 2], stack[sp - 1], stack[sp])
        sp = sp - 3
      elseif op == "JMP" then
        pc = a * 2 + 1
      elseif op == "DECL" then
        cells[a] = { v = stack[sp] }
        sp = sp - 1
      elseif op == "POP" then
        sp = sp - 1
      elseif op == "RET" then
        depth = depth - 1
        return stack[sp]
      elseif op == "GLOBAL_GET" then
        sp = sp + 1
        stack[sp] = env[names[a + 1]]
      elseif op == "GLOBAL_SET" then
        env[names[a + 1]] = stack[sp]
        sp = sp - 1
      elseif op == "DUP" then
        sp = sp + 1
        stack[sp] = stack[sp - 1]
      elseif op == "SWAP" then
        stack[sp], stack[sp - 1] = stack[sp - 1], stack[sp]
      elseif op == "UP_GET" then
        sp = sp + 1
        stack[sp] = ups[a + 1].v
      elseif op == "UP_SET" then
        ups[a + 1].v = stack[sp]
        sp = sp - 1
      elseif op == "UN" then
        stack[sp] = ufn[a + 1](stack[sp])
      elseif op == "JMPT" then
        local v = stack[sp]
        sp = sp - 1
        if v ~= nil and v ~= false then pc = a * 2 + 1 end
      elseif op == "CLOSURE" then
        local child = protos[a + 1]
        local child_ups = {}
        for i = 1, #child.up do
          local d = child.up[i]
          if d[1] == 1 then child_ups[i] = cells[d[2]]
          else child_ups[i] = ups[d[2] + 1] end
        end
        sp = sp + 1
        stack[sp] = make_closure(a + 1, child_ups)
      elseif op == "NEWTABLE" then
        sp = sp + 1
        stack[sp] = {}
      else
        fail("operación desconocida")
      end
    end
  end

  return run_proto(protos[1], {}, {}, 0)
end
`;
