import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { parse as parseCookie } from "cookie";
import { ensureUserApiKey, getUserByDiscordUserId, getUserByOpenId, linkDiscordIdentity, upsertUser } from "./db";
import { createContext } from "./_core/context";
import { ENV } from "./_core/env";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME, ONE_YEAR_MS } from "../shared/const";

const STATE_COOKIE = "__Host-discord_oauth_state";
const CALLBACK_PATH = "/api/discord/callback";
const INVITE_PATH = "/api/discord/invite";
const BOT_INVITE_PERMISSIONS = "268520448"; // View channel, send/embed messages, history and manage roles.

type DiscordState = { nonce: string; redirectUri: string };
type DiscordTokenResponse = { access_token?: string };
type DiscordUser = { id?: string; username?: string; global_name?: string; avatar?: string | null };

function encodeState(state: DiscordState) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeState(value: string): DiscordState | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.nonce === "string" && typeof parsed?.redirectUri === "string") return parsed;
  } catch {
    // Invalid attacker-controlled state fails closed.
  }
  return null;
}

function getOrigin(req: Request) {
  const requestedOrigin = typeof req.query.origin === "string" ? req.query.origin : "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.protocol;
  const host = req.get("host");
  const origin = requestedOrigin || (host ? `${protocol}://${host}` : "");
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && !(url.hostname === "localhost" && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function registerDiscordOAuthRoutes(app: Express) {
  app.get(INVITE_PATH, (_req: Request, res: Response) => {
    if (!ENV.vantaClientId) {
      res.status(503).json({ error: "La invitación del bot no está configurada." });
      return;
    }
    const params = new URLSearchParams({
      client_id: ENV.vantaClientId,
      permissions: BOT_INVITE_PERMISSIONS,
      scope: "bot applications.commands",
      integration_type: "0",
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get("/api/discord/start", (req: Request, res: Response) => {
    if (!ENV.vantaClientId || !ENV.vantaClientSecret) {
      res.status(503).json({ error: "Discord OAuth no está configurado." });
      return;
    }
    const origin = getOrigin(req);
    if (!origin) {
      res.status(400).json({ error: "Origin inválido." });
      return;
    }
    const nonce = crypto.randomBytes(24).toString("hex");
    const redirectUri = `${origin}${CALLBACK_PATH}`;
    const state = encodeState({ nonce, redirectUri });
    // Discord is a cross-site top-level redirect. SameSite=None keeps the
    // nonce available in mobile Chrome and in in-app browsers while the
    // HttpOnly + Secure policy prevents script access in production.
    // Express expects maxAge in milliseconds. 600 would expire in 0.6s,
    // before a mobile browser returns from Discord; keep the OAuth state for 10 minutes.
    res.cookie(STATE_COOKIE, nonce, { ...getSessionCookieOptions(req), maxAge: 10 * 60 * 1000 });
    const params = new URLSearchParams({ client_id: ENV.vantaClientId, redirect_uri: redirectUri, response_type: "code", scope: "identify email", state });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get(CALLBACK_PATH, async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const rawState = typeof req.query.state === "string" ? req.query.state : "";
    const state = decodeState(rawState);
    const expectedNonce = parseCookie(req.headers.cookie ?? "")[STATE_COOKIE];
    if (!code || !state || !expectedNonce || state.nonce !== expectedNonce || !state.redirectUri.endsWith(CALLBACK_PATH)) {
      // A direct/stale callback must return the user to the app instead of
      // exposing a raw JSON page. The state check still fails closed.
      res.redirect("/?discord=oauth-invalid");
      return;
    }
    res.clearCookie(STATE_COOKIE, getSessionCookieOptions(req));

    try {
      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: ENV.vantaClientId, client_secret: ENV.vantaClientSecret, grant_type: "authorization_code", code, redirect_uri: state.redirectUri }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text().catch(() => "");
        console.error("[Discord OAuth] Token exchange rejected", { status: tokenResponse.status, redirectUri: state.redirectUri, body: errorBody.slice(0, 500) });
        if (tokenResponse.status === 400 && /redirect_uri|redirect uri|invalid_request/i.test(errorBody)) {
          throw new Error(`Discord rechazó el redirect URI. Registra exactamente: ${state.redirectUri}`);
        }
        throw new Error("Discord token exchange failed");
      }
      const token = await tokenResponse.json() as DiscordTokenResponse;
      if (!token.access_token) throw new Error("Discord access token missing");

      const userResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!userResponse.ok) throw new Error("Discord user request failed");
      const discordUser = await userResponse.json() as DiscordUser;
      if (!discordUser.id || !discordUser.username) throw new Error("Discord identity missing");

      let currentUser: any = (await createContext({ req, res } as never)).user;
      if (!currentUser) currentUser = await getUserByDiscordUserId(discordUser.id);
      if (!currentUser) {
        const openId = `discord:${discordUser.id}`;
        await upsertUser({ openId, name: discordUser.global_name || discordUser.username, email: null, loginMethod: "discord", lastSignedIn: new Date() });
        currentUser = await getUserByOpenId(openId);
      }
      if (!currentUser) throw new Error("No se pudo crear la cuenta Discord");
      const displayName = discordUser.global_name || discordUser.username;
      const avatarUrl = discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128` : null;
      await linkDiscordIdentity(currentUser.id, discordUser.id, displayName, discordUser.global_name || null, avatarUrl);
      // Provision the user's persistent API key as part of Discord login so every
      // account receives it immediately, even before the first dashboard query.
      await ensureUserApiKey(currentUser.id);
      const sessionToken = await sdk.createSessionToken(currentUser.openId, { name: displayName, expiresInMs: ONE_YEAR_MS });
      res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
      res.redirect("/?discord=connected");
    } catch (error) {
      console.error("[Discord OAuth] Callback failed", error);
      const message = error instanceof Error ? error.message : "No se pudo conectar Discord.";
      res.redirect(`/?discord=${encodeURIComponent(message.includes("redirect URI") ? "redirect-invalid" : "callback-error")}`);
    }
  });
}
