import { buildVantObf } from './build.js';
import fs from 'fs';
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const seed = parseInt(process.argv[3] || '12345', 10);
try {
  const r = buildVantObf(src, seed);
  fs.writeFileSync('/tmp/obf_out.lua', r.code);
  console.log('BUILD OK', JSON.stringify(r.stats));
} catch (e) {
  console.error('BUILD FAIL:', e.message);
  process.exit(1);
}
