local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end
print('fib', fib(12))

local t = {3, 1, 4, 1, 5, 9, 2, 6}
table.sort(t, function(a, b) return a < b end)
print('sorted', table.concat(t, ','))

local M = {}
function M.new(name)
  local self = setmetatable({}, { __index = M })
  self.name = name
  self.n = 0
  return self
end
function M:tick() self.n = self.n + 1 return self.n end
function M:describe() return self.name .. ':' .. self.n end
local m = M.new('prueba')
for i = 1, 3 do m:tick() end
print('obj', m:describe())

local function multi(...)
  return select('#', ...), ...
end
print('multi', multi(1, nil, 3))

local a, b = 10, 3
print('arith', a + b, a - b, a * b, a / b, a % b, a ^ b, -a, #('hola'))
a = a + b; print('comp', a)
a = a - b; a = a * 2; print('comp2', a)

local s = 'ca' .. 'de' .. 'na'
print('concat', s, s:upper(), s:len())

local dict = { x = 1, y = 2 }
dict.z = dict.x + dict.y
print('dict', dict.x, dict.y, dict.z)

local cnt = 0
local function incr() cnt = cnt + 1 end
incr(); incr(); incr()
print('closure', cnt)

local function counter()
  local n = 0
  return function() n = n + 1 return n end, function() n = n - 1 return n end
end
local up, down = counter()
up(); up(); up()
print('shared_upval', up(), down(), up())

local i = 0
repeat i = i + 1 until i >= 5
print('repeat', i)

for k, v in pairs({p = 1, q = 2}) do print('pairs', k, v) end
for idx = 10, 1, -3 do io.write(idx, ' ') end
print()
print('done')
