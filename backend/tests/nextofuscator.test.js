import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLua, BuildError } from '../lib/nextofuscator/build.js';

test('Ofuscador 4 genera el bloque de carga', () => {
  const out = buildLua('local t = {}\nfor i = 1, 3 do t[#t + 1] = i * 2 end\nprint(table.concat(t, ","))\n', 12345);
  assert.match(out.code, /NextOfuscator/);
  assert.ok(out.code.length > 1000);
  assert.ok(out.segments >= 1);
});

test('Ofuscador 4 da BuildError con código Lua inválido', () => {
  assert.throws(() => buildLua('local x = = 1\n', 1), BuildError);
});
