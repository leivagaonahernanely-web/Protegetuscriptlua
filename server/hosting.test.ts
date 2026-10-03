import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMock, licenseMock, activeLicenseMock, blacklistMock, licenseByIdMock, scriptByIdMock } = vi.hoisted(() => ({ findMock: vi.fn(), licenseMock: vi.fn(), activeLicenseMock: vi.fn().mockResolvedValue(undefined), blacklistMock: vi.fn().mockResolvedValue(false), licenseByIdMock: vi.fn(), scriptByIdMock: vi.fn() }));
vi.mock("./db", () => ({ getHostedScriptBySlug: findMock, claimLicenseHwid: licenseMock, getActiveLicenseForHostedScript: activeLicenseMock, isDiscordUserBlacklistedForScript: blacklistMock, getLicenseById: licenseByIdMock, getHostedScriptById: scriptByIdMock }));

import { registerHostingRoutes } from "./hosting";
import { makeLoaderToken } from "./loaderTokens";

type Handler = (req: any, res: any) => Promise<void> | void;

function getHandler(pathPart = "/scripts/hosted") {
  let handler: Handler | undefined;
  registerHostingRoutes({ get: (path: string, next: Handler) => { if (path.includes(pathPart)) handler = next; } } as never);
  return handler!;
}

function responseMock() {
  return {
    statusCode: 200,
    body: "",
    type: vi.fn(function (this: any) { return this; }),
    setHeader: vi.fn(),
    status(code: number) { this.statusCode = code; return this; },
    send(value: string) { this.body = value; return this; },
  };
}

const script = { id: 1, slug: "scriptSlug123456789", name: "demo.lua", code: "return true", ffaMode: 1, scriptKey: null };

beforeEach(() => {
  activeLicenseMock.mockReset().mockResolvedValue(undefined);
  blacklistMock.mockReset().mockResolvedValue(false);
});

describe("public hosted scripts", () => {
  it("requires the global trial token for FFA scripts", async () => {
    findMock.mockResolvedValue(script);
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: {}, headers: { accept: "*/*" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("No key was provided");
  });

  it("renders the FFA loader with the global trial key without source", async () => {
    findMock.mockResolvedValue(script);
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: { key: "trial" }, headers: { accept: "text/html" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("This script can't be viewed in a browser");
    expect(response.body).toContain("script_key = &quot;trial&quot;");
    expect(response.body).toContain("loadstring(game:HttpGet");
    expect(response.body).not.toContain("return true");
  });

  it("requires a valid plan key when FFA is disabled", async () => {
    findMock.mockResolvedValue({ ...script, ffaMode: 0, scriptKey: null });
    licenseMock.mockResolvedValue(undefined);
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: {}, headers: { accept: "*/*" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("No key was provided");
  });

  it("serves a protected artifact when the loader sends HWID as a query parameter", async () => {
    findMock.mockResolvedValue({ ...script, ffaMode: 0, scriptKey: null });
    licenseMock.mockResolvedValue({ id: 4, status: "active" });
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: { key: "86vC3ZULuEQpOImpm5VBB6oLROAQmPLe", hwid: "device-query" }, headers: { accept: "*/*" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("return true");
  });

  it("blocks a Discord-linked license that is blacklisted for this script", async () => {
    findMock.mockResolvedValue({ ...script, ffaMode: 0, scriptKey: null });
    activeLicenseMock.mockResolvedValue({ ownerId: 9, discordUserId: "1501316920975036611" });
    blacklistMock.mockResolvedValue(true);
    licenseMock.mockResolvedValue({ id: 4, status: "active" });
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: { key: "86vC3ZULuEQpOImpmVBB6oLROAQmPLe", hwid: "device-query" }, headers: { accept: "text/html" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(activeLicenseMock).toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("Access blocked for this script");
  });

  it("serves a protected artifact when the key is active", async () => {
    findMock.mockResolvedValue({ ...script, ffaMode: 0, scriptKey: null });
    licenseMock.mockResolvedValue({ id: 4, status: "active" });
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: { key: "86vC3ZULuEQpOImpm5VBB6oLROAQmPLe" }, headers: { accept: "*/*", "x-hwid": "device-a" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("return true");
  });

  it("returns a compact second-stage loader for a valid opaque license token", async () => {
    const protectedScript = { ...script, id: 9, ffaMode: 0, scriptKey: null };
    const license = { id: 4, status: "active", hostedScriptId: 9, keyCode: "86vC3ZULuEQpOImpm5VBB6oLROAQmPLe", expiresAt: null };
    licenseByIdMock.mockResolvedValue(license);
    scriptByIdMock.mockResolvedValue(protectedScript);
    const response = responseMock();
    await getHandler("/scripts/loaders")({ params: { token: makeLoaderToken(license.id, license.keyCode) }, query: {}, headers: { accept: "*/*" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("RbxAnalyticsService");
    expect(response.body).toContain("/scripts/hosted/scriptSlug123456789?key=");
    expect(response.body).toContain("&hwid=\" .. h");
  });

  it("serves only the FFA artifact to non-browser runtime clients with trial", async () => {
    findMock.mockResolvedValue(script);
    const response = responseMock();
    await getHandler()({ params: { slug: script.slug }, query: { key: "trial" }, headers: { accept: "*/*" }, protocol: "https", get: () => "vanta.test" }, response);
    expect(response.body).toBe("return true");
    expect(response.body).not.toContain("loadstring(game:HttpGet");
  });
});
