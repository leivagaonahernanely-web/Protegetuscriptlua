import { createHash } from "node:crypto";
import { ENV } from "./_core/env";

export type ProtectionMode = "fast" | "balanced" | "fortified";
export type ProtectionStatus = "protected" | "review" | "failed";

export type ProtectionOptions = {
  mode: ProtectionMode;
  obfuscateStrings: boolean;
  addLoaderGuard: boolean;
};

export type ProtectionArtifact = {
  code: string;
  checksum: string;
  status: Exclude<ProtectionStatus, "failed">;
  message: string;
};

export interface OfficialProtectionAdapter {
  readonly name: string;
  protect(source: string, options: ProtectionOptions): Promise<ProtectionArtifact>;
}

let officialAdapter: OfficialProtectionAdapter | null = null;

export function registerOfficialProtectionAdapter(adapter: OfficialProtectionAdapter) {
  officialAdapter = adapter;
}

export function getProtectionAdapterStatus() {
  return { provider: officialAdapter?.name ?? "local-runtime-wrapper", official: Boolean(officialAdapter) };
}

export function getProviderStatus() {
  const hasClientId = Boolean(ENV.vantaClientId);
  const hasClientSecret = Boolean(ENV.vantaClientSecret);
  return {
    configured: hasClientId && hasClientSecret,
    hasClientId,
    hasClientSecret,
  };
}

function encodeLua(source: string, obfuscateStrings: boolean, shift = 0) {
  const prepared = obfuscateStrings ? source.split("").reverse().join("") : source;
  const shifted = shift ? Buffer.from(prepared, "utf8").map((byte) => (byte + shift) % 256) : Buffer.from(prepared, "utf8");
  return shifted.toString("base64");
}

function escapeLua(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function buildProtectionArtifact(source: string, options: ProtectionOptions): ProtectionArtifact {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("El script Lua está vacío.");
  const sourceBytes = Buffer.byteLength(trimmed, "utf8");
  if (sourceBytes > 2_000_000) throw new Error("El script supera el límite de 2 MB para esta protección.");

  const checksum = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  const requiresReview = options.mode === "fortified" || /\b(loadstring|load)\s*\(/i.test(trimmed);
  const shift = options.mode === "fortified" ? (parseInt(checksum.slice(0, 2), 16) % 251 || 1) : 0;
  const encoded = encodeLua(trimmed, options.obfuscateStrings, shift);
  const guard = options.addLoaderGuard
    ? `\nlocal __vanta_guard = function()\n  assert(type(__vanta_payload) == "string", "VANTA_GUARD")\nend\n__vanta_guard()`
    : "";
  const modeNote = options.mode === "fast" ? "FAST" : options.mode === "fortified" ? "FORTIFIED" : "BALANCED";
  const stringNote = options.obfuscateStrings ? "STRING_LAYER=ON" : "STRING_LAYER=OFF";

  const code = [
    "-- Vanta.vs Protector / protected artifact",
    `-- CHECKSUM: ${checksum}`,
    `-- MODE: ${modeNote} / ${stringNote}`,
    "local __vanta_payload = \"" + escapeLua(encoded) + "\"",
    "local __vanta_decode = function(value)",
    "  local alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'",
    "  value = value:gsub('[^' .. alphabet .. '=]', '')",
    "  return (value:gsub('.', function(x)",
    "    if x == '=' then return '' end",
    "    local r, f = '', (alphabet:find(x, 1, true) - 1)",
    "    for i = 6, 1, -1 do r = r .. (f % 2^i - f % 2^(i - 1) > 0 and '1' or '0') end",
    "    return r",
    "  end):gsub('%d%d%d?%d?%d?%d?%d?%d?', function(x)",
    "    if #x ~= 8 then return '' end",
    "    local c = 0",
    "    for i = 1, 8 do c = c + (x:sub(i, i) == '1' and 2^(8 - i) or 0) end",
    `    return string.char((c - ${shift}) % 256)`,
    "  end))",
    "end",
    guard.trim(),
    options.obfuscateStrings
      ? "local __vanta_source = string.reverse(__vanta_decode(__vanta_payload))"
      : "local __vanta_source = __vanta_decode(__vanta_payload)",
    options.mode === "fast"
      ? "local __vanta_load = loadstring or load"
      : "local __vanta_load = loadstring or load",
    options.mode === "fortified"
      ? `assert(#__vanta_source > 0, "VANTA_SOURCE")\nassert(${shift} > 0, "VANTA_SHIFT")`
      : "-- VANTA_SOURCE_CHECK: standard",
    "local __vanta_chunk = assert(__vanta_load(__vanta_source))",
    "return __vanta_chunk()",
  ].filter(Boolean).join("\n");

  return {
    code,
    checksum,
    status: requiresReview ? "review" : "protected",
    message: requiresReview ? "Artefacto creado y enviado a revisión preventiva." : "Artefacto protegido y listo para descargar.",
  };
}

export async function protectWithAdapter(source: string, options: ProtectionOptions): Promise<ProtectionArtifact> {
  if (officialAdapter) return officialAdapter.protect(source, options);
  return buildProtectionArtifact(source, options);
}
