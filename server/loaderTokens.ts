import { createHmac, timingSafeEqual } from "node:crypto";
import { ENV } from "./_core/env";

const FALLBACK_SECRET = "vanta-loader-signature";

function signingSecret() {
  return ENV.cookieSecret || FALLBACK_SECRET;
}

export function loaderSignature(licenseId: number, keyCode: string) {
  return createHmac("sha256", signingSecret()).update(`${licenseId}:${keyCode}`).digest("base64url").slice(0, 24);
}

export function makeLoaderToken(licenseId: number, keyCode: string) {
  return `${licenseId}-${loaderSignature(licenseId, keyCode)}.lua`;
}

export function verifyLoaderToken(token: string, licenseId: number, keyCode: string) {
  const expected = loaderSignature(licenseId, keyCode);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
