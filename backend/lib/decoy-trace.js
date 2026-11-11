// Señuelo: texto con forma de traza de ejecución que se entrega a peticiones sin token válido
// repetidas. No contiene código del script real. Cada respuesta cambia nombres, cantidades y tiempos,
// así que no sirve un filtro fijo para reconocerlo.
import crypto from 'crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const rnd = (a, b) => crypto.randomInt(a, b + 1);
const pick = arr => arr[crypto.randomInt(arr.length)];
const name = (n = 1) => Array.from({ length: n }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
const printable = n => Array.from({ length: n }, () => String.fromCharCode(rnd(33, 126))).join('');

export function makeDecoyTrace() {
  const statements = rnd(55, 95);
  const seconds = (rnd(10, 60) / 100).toFixed(2);
  const globalsList = [...new Set(Array.from({ length: rnd(14, 26) }, () => name(1)))].join(', ');
  const bytes = rnd(1600, 3400);
  const junk = Array.from({ length: 4 }, () => printable(rnd(18, 40))).join('\\n');
  const gui = `PlayerGui`;
  const c1 = `child${rnd(3, 30)}`;
  const c2 = `child${rnd(31, 60)}`;
  const c3 = `${pick(['v', 'item', 'obj', 'node'])}${rnd(1, 9)}`;
  const p1 = name(rnd(2, 4));

  return [
    `-- source: input.lua`,
    `-- Behavior trace: only what ran at runtime (taken branches), not the original code.`,
    `-- run status: finished`,
    `-- ${statements} statements recorded in ${seconds}s`,
    `-- non-standard globals touched: ${globalsList}`,
    ``,
    `-- loadstring() of ${bytes} bytes: "--[[\\n${junk}"`,
    `-- (environment probes removed from the trace)`,
    `local Players = game:GetService("Players")`,
    `local ${gui} = Players.LocalPlayer:WaitForChild("${gui}")`,
    ``,
    `${gui}.ChildAdded:Connect(function(${c1})`,
    `\t${c1}.AncestryChanged:Connect(function(${p1}, parent)`,
    `\tend)`,
    `end)`,
    ``,
    `${gui}.ChildRemoved:Connect(function(${c2})`,
    `end)`,
    ``,
    `for ${c3}Index, ${c3} in ipairs(${gui}:GetChildren()) do`,
    `end`,
    ``,
    `-- [envlog] end of trace`,
    ``,
  ].join('\n');
}
