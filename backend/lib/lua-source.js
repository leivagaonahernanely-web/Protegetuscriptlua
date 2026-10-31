// Limpia el código del usuario antes de ofuscarlo. Un BOM (marca invisible que agregan algunos
// editores en Windows) o una línea "#!" al inicio hacen que el código falle al compilarse como
// texto, aunque Lua los acepte al ejecutar un archivo. Se convierten en comentarios para que las
// líneas sigan igual de numeradas.
export function normalizeLuaSource(source) {
  let s = String(source ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  if (s.startsWith('#')) s = '--' + s;
  return s;
}
