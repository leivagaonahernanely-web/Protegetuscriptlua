import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRemoteBlocks, remoteBlocks, stripRemoteBlocks, hasRemoteBlocks, remoteHeader, hasStrayMarkers } from '../lib/remote-blocks.js';

const SRC = [
  'local x = 1',
  'local config = --@remote:config',
  '  { speed = 16, webhook = "https://ejemplo.test" }',
  '--@endremote',
  '  local t = --@remote:tabla',
  '    { a = 1 }',
  '  --@endremote',
  'print(config.speed)',
].join('\n');

test('detecta bloques y saca sus expresiones', () => {
  assert.equal(validateRemoteBlocks(SRC).error, undefined);
  assert.equal(hasRemoteBlocks(SRC), true);
  const blocks = remoteBlocks(SRC);
  assert.equal(blocks.get('config').trim(), '{ speed = 16, webhook = "https://ejemplo.test" }');
  assert.equal(blocks.get('tabla').trim(), '{ a = 1 }');
});

test('al entregar, el secreto desaparece y queda la llamada con la sangría original', () => {
  const out = stripRemoteBlocks(SRC);
  assert.equal(out.includes('webhook'), false);
  assert.equal(out.includes('a = 1'), false);
  assert.ok(out.includes('local config = __vm_remote("config")'));
  assert.ok(out.includes('  local t = __vm_remote("tabla")'));
  assert.ok(out.includes('print(config.speed)'));
});

test('el script sin bloques no cambia', () => {
  const plain = 'print("hola")\nlocal a = 2';
  assert.equal(stripRemoteBlocks(plain), plain);
  assert.equal(hasRemoteBlocks(plain), false);
});

test('rechaza bloques sin cerrar, repetidos o vacíos', () => {
  assert.match(validateRemoteBlocks('local a = --@remote:a\n  1\n').error, /sin cerrar/);
  const dup = '--@remote:a\n1\n--@endremote\n--@remote:a\n2\n--@endremote';
  assert.match(validateRemoteBlocks(dup).error, /repetido/);
  const empty = '--@remote:a\n   \n--@endremote';
  assert.match(validateRemoteBlocks(empty).error, /vacío/);
  const badName = '--@remote:con-guion\n1\n--@endremote';
  assert.ok(validateRemoteBlocks(badName).error);
});

test('la cabecera define __vm_remote con el token y la URL', () => {
  const head = remoteHeader({ url: 'https://app.test/scripts/hosted/x/remote', token: 'abc123' });
  assert.ok(head.startsWith('local __vm_session = "abc123"'));
  assert.ok(head.includes('"https://app.test/scripts/hosted/x/remote"'));
  assert.ok(head.includes('local function __vm_remote(name)'));
  assert.ok(head.includes('loadstring("return " .. body)'));
});

test('marcadores sueltos se detectan', () => {
  assert.equal(hasStrayMarkers(SRC), false);
  assert.equal(hasStrayMarkers('local a = 1 --@endremote'), true);
});
