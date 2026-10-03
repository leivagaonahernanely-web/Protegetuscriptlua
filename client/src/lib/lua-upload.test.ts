import { describe, expect, it } from "vitest";
import { LUA_SOURCE_LIMIT, readLuaFile, validateLuaFile } from "./lua-upload";

describe("Lua file upload", () => {
  it("accepts a Lua file at the configured limit", () => {
    expect(validateLuaFile({ name: "script.lua", size: LUA_SOURCE_LIMIT })).toBeNull();
  });

  it("reads the Lua source through the browser file API", async () => {
    await expect(readLuaFile({ name: "script.lua", size: 12, text: () => Promise.resolve("print('ok')") } as unknown as File)).resolves.toBe("print('ok')");
  });

  it("accepts Lua text files and rejects unsupported or oversized files", () => {
    expect(validateLuaFile({ name: "source.txt", size: 10 })).toBeNull();
    expect(validateLuaFile({ name: "source.luau", size: 10 })).toBeNull();
    expect(validateLuaFile({ name: "source.exe", size: 10 })).toBe("Selecciona un archivo .lua, .luau o .txt");
    expect(validateLuaFile({ name: "script.lua", size: LUA_SOURCE_LIMIT })).toBeNull();
    expect(validateLuaFile({ name: "script.lua", size: LUA_SOURCE_LIMIT + 1 })).toBe("El archivo supera el límite de 2 MB");
  });
});
