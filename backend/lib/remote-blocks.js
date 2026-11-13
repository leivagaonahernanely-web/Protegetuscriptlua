// Bloques remotos (Fase 1): partes del script que el servidor guarda y entrega solo bajo demanda.
//
// En el código del dueño se marcan así (la expresión Lua queda entre las dos líneas):
//   local config = --@remote:config
//     { speed = 16, webhook = "https://..." }
//   --@endremote
//
// Al entregar el script, cada bloque se reemplaza por  __vm_remote("config")  y el ejecutor
// pide la expresión real al servidor con un token de sesión.

// Grupo 1: lo que hay antes del marcador en la misma línea (p. ej. "local config = ")
const OPEN = /^([^\n]*?)--@remote:([A-Za-z0-9_]{1,40})[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*--@endremote[ \t]*$/gm;
const STRAY_MARK = /--@(remote|endremote)\b/;

// Devuelve { error } si los marcadores están mal, o { names } con los nombres de los bloques
export function validateRemoteBlocks(source) {
  const text = String(source ?? '');
  const opens = (text.match(/--@remote:/g) || []).length;
  const ends = (text.match(/--@endremote/g) || []).length;
  if (opens !== ends) return { error: 'Hay bloques --@remote sin cerrar con --@endremote (o al revés).' };
  const names = new Set();
  for (const m of text.matchAll(OPEN)) {
    const name = m[2];
    if (names.has(name)) return { error: `El bloque --@remote:${name} está repetido.` };
    if (!m[3].trim()) return { error: `El bloque --@remote:${name} está vacío.` };
    names.add(name);
  }
  if (opens !== names.size) return { error: 'Revisa la sintaxis de los bloques --@remote: el nombre debe ser letras, números o _ (máx. 40).' };
  return { names: [...names] };
}

// Lista de bloques: name -> expresión Lua
export function remoteBlocks(source) {
  const blocks = new Map();
  for (const m of String(source ?? '').matchAll(OPEN)) blocks.set(m[2], m[3]);
  return blocks;
}

// Código que se entrega: cada bloque se reemplaza por la llamada remota (conserva la sangría)
export function stripRemoteBlocks(source) {
  return String(source ?? '').replace(OPEN, (_, before, name) => `${before}__vm_remote("${name}")`);
}

export function hasRemoteBlocks(source) {
  return remoteBlocks(source).size > 0;
}

// Cabecera Lua que define __vm_remote dentro del mismo fragmento que el código del script
export function remoteHeader({ url, token }) {
  const q = s => JSON.stringify(String(s));
  return [
    `local __vm_session = ${q(token)}`,
    '__vm_remote = function(name)',   // global: el payload ofuscado resuelve globales vía _G
    '  local ok, body = pcall(function()',
    `    return game:HttpGet(${q(url)} .. "?name=" .. name .. "&token=" .. __vm_session)`,
    '  end)',
    '  if not ok or type(body) ~= "string" or body:sub(1, 11) == "!VANTARMOR:" then',
    '    error("[VantArmor] No se pudo cargar el bloque remoto " .. name, 2)',
    '  end',
    '  local fn, cerr',
    '  if body:sub(1, 16) == "--VANTARMOR:OBF\\n" then',
    '    fn, cerr = loadstring(body:sub(17))',
    '  else',
    '    fn, cerr = loadstring("return " .. body)',
    '  end',
    '  if not fn then error("[VantArmor] Bloque remoto " .. name .. " inválido: " .. tostring(cerr), 2) end',
    '  return fn()',
    'end',
    '',
  ].join('\n');
}

// Para revisar que el dueño no dejó marcadores sueltos fuera de un bloque válido
export function hasStrayMarkers(source) {
  const cleaned = String(source ?? '').replace(OPEN, '');
  return STRAY_MARK.test(cleaned);
}
