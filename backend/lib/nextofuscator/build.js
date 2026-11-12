export class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}
export function buildLua(source, seed) {
  if (typeof source !== 'string' || !source.trim()) throw new BuildError('source vacío');
  return { code: source };
}
