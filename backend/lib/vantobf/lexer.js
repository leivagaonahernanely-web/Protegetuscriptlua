// VantObf - Lexer Lua 5.1 + extensiones Luau (asignaciones compuestas, continue)
export class LexError extends Error { constructor(msg, line) { super(`Linea ${line}: ${msg}`); this.line = line; } }

const KW = new Set(['and','break','do','else','elseif','end','false','for','function','if','in',
  'local','nil','not','or','repeat','return','then','true','until','while','continue']);

const PUNCT = [
  '...','..','.','::',':',',',';','(',')','[',']','{','}','+','-','*','/','//','%','^','#','==','~=','!=','<=','>=','<','>','=','+=','-=','*=','/=','%=','^=','..=','->','&&','||','&','|','?','!'
];
// orden: los mas largos primero
PUNCT.sort((a,b) => b.length - a.length);

const ESC = { a:'\x07', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t', v:'\v', '\\':'\\', '"':'"', "'":"'", '\n':'\n' };

export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  function push(type, value) { toks.push({ type, value, line }); }
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') { i++; continue; }
    // comentarios largos
    if (c === '-' && src[i+1] === '-') {
      let j = i + 2, lvl = 0;
      if (src[j] === '[') {
        j++;
        while (src[j] === '=') { lvl++; j++; }
        if (src[j] === '[') {
          const close = ']' + '='.repeat(lvl) + ']';
          const end = src.indexOf(close, j + 1);
          if (end === -1) throw new LexError('comentario largo sin cerrar', line);
          for (let k = i; k < end + close.length; k++) if (src[k] === '\n') line++;
          i = end + close.length; continue;
        }
      }
      // directiva de macro: --# ...
      if (src[i+2] === '#') {
        let j = i + 3, txt = '';
        while (j < n && src[j] !== '\n') { txt += src[j]; j++; }
        push('dir', txt);
        i = j; continue;
      }
      // comentario de linea normal
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // shebang / luau type annotations basicas: <, :: se tratan como punct
    if (c >= '0' && c <= '9' || (c === '.' && src[i+1] >= '0' && src[i+1] <= '9')) {
      const s = src.slice(i);
      let m = null;
      let isHex = /^0[xX]/.test(s);
      if (isHex) {
        m = s.match(/^0[xX][0-9a-fA-F_]*\.?[0-9a-fA-F_]*(?:[pP][+-]?\d+)?/);
        if (m && !/[0-9a-fA-F]/.test(m[0].slice(2).replace(/\./g, ''))) m = null;
      } else {
        m = s.match(/^(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/);
      }
      if (!m || !m[0]) throw new LexError('numero mal formado', line);
      const txt = m[0].replace(/_/g, '');
      let val;
      if (isHex) {
        const pm = txt.match(/[pP]([+-]?\d+)$/);
        const exp = pm ? parseInt(pm[1], 10) : 0;
        const mant = txt.replace(/[pP][+-]?\d+$/, '');
        const body = mant.slice(2);
        if (body.indexOf('.') === -1) {
          val = parseInt(body, 16) * Math.pow(2, exp);
        } else {
          const dot = body.indexOf('.');
          const ip = body.slice(0, dot) || '0';
          const fp = body.slice(dot + 1);
          val = (parseInt(ip, 16) + parseInt(fp || '0', 16) * Math.pow(2, -4 * fp.length)) * Math.pow(2, exp);
        }
      } else {
        val = parseFloat(txt);
      }
      push('num', val); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j+1];
          if (e === '\n') { out += '\n'; j += 2; line++; continue; }
          if (e === 'x' || e === 'X') { out += String.fromCharCode(parseInt(src.slice(j+2, j+4), 16)); j += 4; continue; }
          if (e === 'z' || e === 'Z') { let k = j + 2; while (src[k] === ' ' || src[k] === '\n' || src[k] === '\t' || src[k] === '\r') { if (src[k] === '\n') line++; k++; } j = k; continue; }
          if (e === 'z') { j += 2; continue; }
          if (e >= '0' && e <= '9') { const m2 = src.slice(j+1).match(/^\d{1,3}/); out += String.fromCharCode(parseInt(m2[0], 10)); j += 1 + m2[0].length; continue; }
          const ch = ESC[e]; if (ch === undefined) throw new LexError('escape desconocido \\' + e, line);
          out += ch; j += 2; continue;
        }
        if (src[j] === '\n') throw new LexError('cadena sin cerrar', line);
        out += src[j]; j++;
      }
      if (j >= n) throw new LexError('cadena sin cerrar', line);
      push('str', out); i = j + 1; continue;
    }
    // cadena larga [[ ... ]] con nivel =
    if (c === '[') {
      let j = i + 1, lvl = 0;
      while (src[j] === '=') { lvl++; j++; }
      if (src[j] === '[') {
        const open = '[' + '='.repeat(lvl) + '[';
        const close = ']' + '='.repeat(lvl) + ']';
        let start = j + 1;
        if (src[start] === '\n') { start++; line++; }
        const end = src.indexOf(close, start);
        if (end === -1) throw new LexError('cadena larga sin cerrar', line);
        for (let k = i; k < end; k++) if (src[k] === '\n') line++;
        push('str', src.slice(start, end)); i = end + close.length; continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      push(KW.has(w) ? 'kw' : 'name', w); i = j; continue;
    }
    const p = PUNCT.find(pp => src.startsWith(pp, i));
    if (!p) throw new LexError('caracter inesperado ' + JSON.stringify(c), line);
    push('punct', p); i += p.length; continue;
  }
  push('eof', null);
  return toks;
}
