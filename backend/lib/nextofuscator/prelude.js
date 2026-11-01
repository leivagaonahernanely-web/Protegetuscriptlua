// Bloque previo al runtime: en Roblox espera dos Heartbeat antes de ejecutar el script protegido.
// Usa sintaxis Lua 5.1 (sin "+=") y queda desactivado fuera de Roblox, donde `game` no existe.
export const PRELUDE_LUA = `if game ~= nil and type(game.GetService) == "function" then
  do
    local RanTimes = 0
    local Connection = game:GetService("RunService").Heartbeat:Connect(function()
      RanTimes = RanTimes + 1
    end)
    repeat
      task.wait()
    until RanTimes >= 2
    Connection:Disconnect()
  end
end
`;
