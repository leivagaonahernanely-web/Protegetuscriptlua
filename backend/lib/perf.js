// Revisión de rendimiento por texto: encuentra código que cuesta en cada vuelta de un bucle
// o en cada frame, y explica cómo mejorarlo. Sirve para el editor y para la tarjeta del script.

const LOOP_RE = /^\s*(for|while)\b.*\bdo\b|^\s*repeat\b/;
const HOT_RE = /\b(RenderStepped|Heartbeat|Stepped|PreRender|PreSimulation|PostSimulation)\s*:\s*[Cc]onnect\s*\(/;
const LOOKUP_RE = /GetService\s*\(|FindFirstChild|WaitForChild|workspace\.|:FindFirst/;
const NEW_INSTANCE_RE = /Instance\.new\s*\(/;
const CONCAT_RE = /[^.]\.\.[^.]/;
const FORMAT_RE = /string\.format\s*\(|tostring\s*\(/;

const indentOf = ln => ln.match(/^\s*/)[0];
const isComment = ln => /^\s*--/.test(ln);

// Rango de líneas de un bloque que empieza en i; termina en la línea con la misma sangría que cierra el bloque
function blockRange(lines, i, closeRe) {
  if (/\bend\b/.test(lines[i]) && !/\bfunction\b/.test(lines[i]) && lines[i].split(/\bend\b/).length > 1) return [i, i];
  const indent = indentOf(lines[i]);
  for (let j = i + 1; j < lines.length; j++) {
    if (indentOf(lines[j]) === indent && closeRe.test(lines[j])) return [i, j];
  }
  return [i, lines.length - 1];
}

function regionsOf(lines, startRe, closeRe) {
  const out = [];
  lines.forEach((ln, i) => { if (startRe.test(ln)) out.push(blockRange(lines, i, closeRe)); });
  return out;
}

// obfuscator: 'clyde' | 'obscura' | 'luau' | 'none'; vm: true si el Ofuscador 1 usa máquina virtual
export function analyzePerf(source, { obfuscator = 'clyde', vm = false } = {}) {
  const lines = String(source || '').split('\n');
  const loops = regionsOf(lines, LOOP_RE, /^\s*(end|until)\b/);
  const hot = regionsOf(lines, HOT_RE, /^\s*end\)?\s*$/);
  const inside = (i, regions) => regions.some(([a, b]) => i >= a && i <= b);
  const findings = [];
  const seen = new Set();
  const add = (severity, line, title, tip) => {
    const key = `${line}:${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ severity, line: line + 1, title, tip });
  };

  if (obfuscator === 'clyde' && vm && hot.length) {
    add('high', hot[0][0], 'Código por frame con máquina virtual',
      'Cada frame pasa por la VM y baja los FPS. Desactiva la VM o saca este código del callback.');
  } else if (hot.length) {
    add('medium', hot[0][0], 'Código que corre cada frame',
      'Mantén este callback corto y evita buscar objetos o crear tablas dentro.');
  }

  lines.forEach((ln, i) => {
    if (isComment(ln)) return;
    const inHot = inside(i, hot);
    const inLoop = inside(i, loops);
    if (!inHot && !inLoop) return;
    const where = inHot ? 'cada frame' : 'cada vuelta del bucle';

    if (LOOKUP_RE.test(ln)) {
      add(inHot ? 'high' : 'medium', i, `Busca objetos ${where}`,
        'Guárdalos en una variable al inicio y úsala después.');
    }
    if (NEW_INSTANCE_RE.test(ln)) {
      add('medium', i, `Crea objetos ${where}`,
        'Crea los objetos una vez y reutilízalos, o reutiliza un pool.');
    }
    if (CONCAT_RE.test(ln)) {
      add('medium', i, `Concatena texto ${where}`,
        'Cada .. crea un texto nuevo. Junta las partes con table.concat al final.');
    }
    if (FORMAT_RE.test(ln)) {
      add('low', i, `Formatea texto ${where}`,
        'Si el texto no cambia, calcúlalo una vez fuera del bucle.');
    }
  });

  const level = findings.some(f => f.severity === 'high') ? 'alto'
    : findings.some(f => f.severity === 'medium') ? 'medio' : 'bajo';
  return { level, loops: loops.length, hot: hot.length, findings };
}
