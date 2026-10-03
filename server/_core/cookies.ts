import type { CookieOptions, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto) {
    const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
    if (protoList.some(proto => proto.trim().toLowerCase() === "https")) return true;
  }

  if (req.protocol === "https") return true;

  // Some managed proxies leave req.protocol as http and omit the forwarded
  // header. Public Manus domains are HTTPS-only, so infer Secure from a real
  // non-local hostname; otherwise SameSite=None cookies are rejected by Chrome.
  const hostname = String(req.hostname || req.get?.("host") || "").split(":")[0].toLowerCase();
  return Boolean(hostname && !LOCAL_HOSTS.has(hostname) && !isIpAddress(hostname));
}

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  // const hostname = req.hostname;
  // const shouldSetDomain =
  //   hostname &&
  //   !LOCAL_HOSTS.has(hostname) &&
  //   !isIpAddress(hostname) &&
  //   hostname !== "127.0.0.1" &&
  //   hostname !== "::1";

  // const domain =
  //   shouldSetDomain && !hostname.startsWith(".")
  //     ? `.${hostname}`
  //     : shouldSetDomain
  //       ? hostname
  //       : undefined;

  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    path: "/",
    sameSite: secure ? "none" : "lax",
    secure,
  };
}
