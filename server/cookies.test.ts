import { describe, expect, it } from "vitest";
import { getSessionCookieOptions } from "./_core/cookies";

describe("session cookie options", () => {
  it("uses Secure and SameSite=None for a public host even when the proxy reports http", () => {
    const options = getSessionCookieOptions({
      protocol: "http",
      hostname: "vanta-prot-hfw5hmym.manus.space",
      headers: {},
      get: () => "vanta-prot-hfw5hmym.manus.space",
    } as never);

    expect(options).toMatchObject({ secure: true, sameSite: "none", httpOnly: true, path: "/" });
  });

  it("keeps localhost usable over plain http", () => {
    const options = getSessionCookieOptions({
      protocol: "http",
      hostname: "localhost",
      headers: {},
      get: () => "localhost:3000",
    } as never);

    expect(options).toMatchObject({ secure: false, sameSite: "lax", httpOnly: true, path: "/" });
  });
});
