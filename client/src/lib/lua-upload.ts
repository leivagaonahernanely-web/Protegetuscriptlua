export const LUA_SOURCE_LIMIT = 2 * 1024 * 1024;

export function validateLuaFile(file: Pick<File, "name" | "size">) {
  if (!/\.(lua|luau|txt)$/i.test(file.name)) return "Selecciona un archivo .lua, .luau o .txt";
  if (file.size > LUA_SOURCE_LIMIT) return "El archivo supera el límite de 2 MB";
  return null;
}

export function readLuaFile(file: File): Promise<string> {
  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Formato de archivo no compatible"));
      reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo Lua"));
      reader.onabort = () => reject(new Error("Lectura cancelada"));
      reader.readAsText(file, "utf-8");
    });
  }
  if (typeof file.text === "function") return file.text();
  return Promise.reject(new Error("Este navegador no permite leer archivos Lua"));
}
