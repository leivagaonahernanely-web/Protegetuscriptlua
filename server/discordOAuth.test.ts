import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  linkDiscordIdentity: vi.fn().mockResolvedValue(undefined),
  getUserByDiscordUserId: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  ensureUserApiKey: vi.fn().mockResolvedValue("VANTA-test-api-key"),
  createContext: vi.fn().mockResolvedValue({ user: { id: 7, openId: "existing-user" } }),
}));

vi.mock("./db", () => ({ linkDiscordIdentity: mocks.linkDiscordIdentity, getUserByDiscordUserId: mocks.getUserByDiscordUserId, getUserByOpenId: mocks.getUserByOpenId, upsertUser: mocks.upsertUser, ensureUserApiKey: mocks.ensureUserApiKey }));
vi.mock("./_core/context", () => ({ createContext: mocks.createContext }));

import { registerDiscordOAuthRoutes } from "./discordOAuth";

type Handler = (req: any, res: any) => Promise<void> | void;

function registeredRoutes() {
  const routes = new Map<string, Handler>();
  const app = { get: (path: string, handler: Handler) => routes.set(path, handler) };
  registerDiscordOAuthRoutes(app as never);
  return routes;
}

function responseMock() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    redirectTarget: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    redirect(value: unknown) { this.redirectTarget = value; return this; },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

describe("Discord OAuth callback", () => {
  it("builds a separate official bot invite without an OAuth callback", async () => {
    const response = responseMock();
    await registeredRoutes().get("/api/discord/invite")?.({ query: {} }, response);
    const invite = new URL(String(response.redirectTarget));
    expect(invite.origin).toBe("https://discord.com");
    expect(invite.pathname).toBe("/oauth2/authorize");
    expect(invite.searchParams.get("scope")).toContain("bot");
    expect(invite.searchParams.get("scope")).toContain("applications.commands");
    expect(invite.searchParams.get("redirect_uri")).toBeNull();
  });

  it("builds the canonical callback from the request host when origin is omitted", async () => {
    const routes = registeredRoutes();
    const response = responseMock();
    await routes.get("/api/discord/start")?.({ query: {}, protocol: "https", headers: {}, get: () => "example.com" }, response);
    expect(String(response.redirectTarget)).toContain(encodeURIComponent("https://example.com/api/discord/callback"));
    expect(response.cookie).toHaveBeenCalledWith("__Host-discord_oauth_state", expect.any(String), expect.objectContaining({ sameSite: "none", secure: true, httpOnly: true, path: "/", maxAge: 600000 }));
  });

  it("generates the same canonical callback for preview and published hosts", async () => {
    const start = registeredRoutes().get("/api/discord/start");
    for (const host of ["3000-iv3as1cf859kyo1na8z69-7177b250.us3.manus.computer", "vanta-prot-hfw5hmym.manus.space"]) {
      const response = responseMock();
      await start?.({ query: { origin: `https://${host}` }, protocol: "https", headers: {}, get: () => host }, response);
      expect(String(response.redirectTarget)).toContain(encodeURIComponent(`https://${host}/api/discord/callback`));
    }
  });

  it("accepts the callback state generated for the published host", async () => {
    const routes = registeredRoutes();
    const startResponse = responseMock();
    await routes.get("/api/discord/start")?.({ query: { origin: "https://vanta-prot-hfw5hmym.manus.space" }, protocol: "https", headers: {}, get: () => "vanta-prot-hfw5hmym.manus.space" }, startResponse);
    const authorizationUrl = new URL(String(startResponse.redirectTarget));
    const state = authorizationUrl.searchParams.get("state");
    const nonce = startResponse.cookie.mock.calls[0]?.[1];
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "111222333444555666", username: "vanta-user", global_name: "Vanta User" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const callbackResponse = responseMock();
    await routes.get("/api/discord/callback")?.({ query: { code: "real-code", state }, headers: { cookie: `__Host-discord_oauth_state=${nonce}` } }, callbackResponse);
    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.redirectTarget).toBe("/?discord=connected");
    vi.unstubAllGlobals();
  });

  it("creates a web session directly when Discord is the first login", async () => {
    const routes = registeredRoutes();
    const nonce = "nonce-direct-login";
    const redirectUri = "https://example.com/api/discord/callback";
    const state = Buffer.from(JSON.stringify({ nonce, redirectUri }), "utf8").toString("base64url");
    mocks.createContext.mockResolvedValueOnce({ user: null });
    mocks.getUserByDiscordUserId.mockResolvedValueOnce(undefined);
    mocks.getUserByOpenId.mockResolvedValueOnce({ id: 8, openId: "discord:111222333444555666" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "111222333444555666", username: "discord-user", global_name: "Discord User" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = responseMock();
    await routes.get("/api/discord/callback")?.({ query: { code: "real-code", state }, headers: { cookie: `__Host-discord_oauth_state=${nonce}` } }, response);
    expect(mocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ openId: "discord:111222333444555666", loginMethod: "discord" }));
    expect(response.cookie).toHaveBeenCalled();
    expect(response.redirectTarget).toBe("/?discord=connected");
    vi.unstubAllGlobals();
  });

  it("rejects malformed or mismatched state before redeeming a code", async () => {
    const routes = registeredRoutes();
    const response = responseMock();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const handler = routes.get("/api/discord/callback");
    await handler?.({ query: { code: "attacker-code", state: "not-valid" }, headers: { cookie: "" } }, response);
    expect(response.redirectTarget).toBe("/?discord=oauth-invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("exchanges the code, links the Discord identity, and redirects", async () => {
    const routes = registeredRoutes();
    const nonce = "nonce-for-test";
    const redirectUri = "https://example.com/api/discord/callback";
    const state = Buffer.from(JSON.stringify({ nonce, redirectUri }), "utf8").toString("base64url");
    const response = responseMock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "111222333444555666", username: "vanta-user", global_name: "Vanta User" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await routes.get("/api/discord/callback")?.(
      { query: { code: "real-code", state }, protocol: "https", hostname: "vanta-prot-hfw5hmym.manus.space", headers: { cookie: `__Host-discord_oauth_state=${nonce}` }, get: () => "vanta-prot-hfw5hmym.manus.space" },
      response,
    );

    expect(mocks.linkDiscordIdentity).toHaveBeenCalledWith(7, "111222333444555666", "Vanta User", "Vanta User", null);
    expect(response.cookie).toHaveBeenCalledWith("app_session_id", expect.any(String), expect.objectContaining({ secure: true, sameSite: "none", httpOnly: true, path: "/" }));
    expect(response.redirectTarget).toBe("/?discord=connected");
    expect(response.clearCookie).toHaveBeenCalledWith("__Host-discord_oauth_state", expect.objectContaining({ sameSite: "none", path: "/" }));
    vi.unstubAllGlobals();
  });
});
