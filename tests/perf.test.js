import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePerf } from '../lib/perf.js';

test('código limpio queda en bajo', () => {
  const r = analyzePerf('local x = 1\nprint(x)\n', { obfuscator: 'clyde', vm: true });
  assert.equal(r.level, 'bajo');
  assert.equal(r.findings.length, 0);
});

test('buscar objetos en Heartbeat con VM de Clyde es alto', () => {
  const src = [
    'RunService.Heartbeat:Connect(function(dt)',
    '  local p = workspace:FindFirstChild("Part")',
    'end)',
  ].join('\n');
  const r = analyzePerf(src, { obfuscator: 'clyde', vm: true });
  assert.equal(r.level, 'alto');
  assert.equal(r.hot, 1);
  assert.ok(r.findings.some(f => f.title.includes('Código por frame con máquina virtual')));
});

test('concatenar dentro de un bucle es medio', () => {
  const src = 'local s = ""\nfor i = 1, 10 do\n  s = s .. i\nend\n';
  const r = analyzePerf(src, { obfuscator: 'obscura' });
  assert.equal(r.loops, 1);
  assert.equal(r.level, 'medio');
  assert.equal(r.findings[0].line, 3);
});

test('bucle de una línea cuenta y no se extiende de más', () => {
  const r = analyzePerf('for i = 1, 3 do print(i) end\nlocal y = 2\n', { obfuscator: 'none' });
  assert.equal(r.loops, 1);
  assert.equal(r.level, 'bajo');
});

test('crear instancias dentro de un bucle es medio', () => {
  const src = 'while true do\n  local p = Instance.new("Part")\n  task.wait()\nend\n';
  const r = analyzePerf(src, { obfuscator: 'luau' });
  assert.equal(r.level, 'medio');
});
