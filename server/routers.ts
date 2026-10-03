import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { notifyOwner } from "./_core/notification";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createAccessRule, createBlacklist, createDiscordPanel, createHostedScript, createLicense, createProtection, deleteAccessRule, deleteBlacklist, deleteLicense, getAccessRulesByOwner, getBlacklistsByOwner, getDiscordPanelsByOwner, getHostedScriptSourceByUser, getHostedScriptsByUser, getHostedScriptByName, getHostedScriptById, getHostedScriptByOwnerId, updateHostedScript, deleteHostedScript, getWorkspaceUsage, getKeyAuditLogsByOwner, deleteKeyAuditLogsByOwner, getLicensesByOwner, getProtectionsByUser, resetLicenseHwid, revokeLicense, redeemPlanKey, updateDiscordChannelId, updateDiscordContentChannels, ensureUserApiKey, getPublishedScriptsForOwnerReview } from "./db";
import { nanoid } from "nanoid";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { checkDiscordChannel, getDiscordBotIdentity, sendDiscordChannelMessage } from "./discord";
import { deletePublishedPanel, getDiscordGatewayStatus, publishDiscordPanel, publishPricesMessage, publishUpdatesMessage } from "./discordBot";
import { getProtectionAdapterStatus, getProviderStatus, protectWithAdapter } from "./protection";
import { durationToDays, type DurationUnit } from "../shared/duration";
import { PLAN_DEFINITIONS, type PlanTier } from "../shared/plans";
import { ENV } from "./_core/env";

const ownerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ENV.ownerOpenId || ctx.user.openId !== ENV.ownerOpenId || ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Solo el owner puede administrar este workspace." });
  return next({ ctx });
});

const hostedScriptInput = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(500).optional(),
  source: z.string().min(1).max(2_000_000).optional(),
  sourceBase64: z.string().min(1).max(2_800_000).optional(),
  sourceGzipBase64: z.string().min(1).max(2_800_000).optional(),
  ffaMode: z.boolean().default(false),
  scriptKey: z.string().trim().regex(/^(?:FREE|PRO|PREMIUM)-[a-z0-9]{16}$/i).optional(),
  obfuscateSource: z.boolean().default(true),
}).refine((input) => Boolean(input.source || input.sourceBase64 || input.sourceGzipBase64), { message: "La source es obligatoria." });

function decodeHostedSource(input: { source?: string; sourceBase64?: string; sourceGzipBase64?: string }) {
  if (input.source) return input.source;
  if (!input.sourceBase64 && !input.sourceGzipBase64) throw new TRPCError({ code: "BAD_REQUEST", message: "La source es obligatoria." });
  let source: string;
  try {
    const encoded = input.sourceGzipBase64 || input.sourceBase64!;
    const bytes = Buffer.from(encoded, "base64");
    source = input.sourceGzipBase64 ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "La source codificada no es válida." });
  }
  if (!source || source.length > 2_000_000) throw new TRPCError({ code: "BAD_REQUEST", message: "La source debe tener entre 1 byte y 2 MB." });
  return source;
}

function buildRuntimeLoader(url: string, scriptKey?: string | null, ffaMode = false) {
  const runtimeKey = ffaMode ? "trial" : scriptKey;
  const accessUrl = runtimeKey ? `${url}?key=${encodeURIComponent(runtimeKey)}` : url;
  const load = ffaMode || !runtimeKey
    ? `loadstring(game:HttpGet(\"${accessUrl}\"))()`
    : `local hwid = game:GetService(\"RbxAnalyticsService\"):GetClientId()\nloadstring(game:HttpGet(\"${accessUrl}&hwid=\" .. hwid))()`;
  return runtimeKey ? `script_key = \"${runtimeKey}\"\n${load}` : load;
}

const licenseInput = z.object({
  type: z.literal("license").default("license"),
  plan: z.enum(["free", "pro", "premium"]).default("free"),
  hostedScriptId: z.number().int().positive().optional(),
  discordUserId: z.string().trim().regex(/^\d{15,22}$/).optional(),
  trialDays: z.number().int().min(1).max(3650).default(3),
  durationValue: z.number().int().min(1).max(3650).optional(),
  durationUnit: z.enum(["days", "months", "years"]).default("days"),
  keyKind: z.enum(["normal", "plan"]).default("normal"),
});
const accessRuleInput = z.object({ kind: z.enum(["user", "role"]), discordId: z.string().trim().regex(/^\d{15,22}$/), hostedScriptId: z.number().int().positive(), label: z.string().trim().max(128).optional() });
const blacklistInput = z.object({ hostedScriptId: z.number().int().positive(), discordUserId: z.string().trim().regex(/^\d{15,22}$/), reason: z.string().trim().max(500).optional() });

async function assertWorkspaceQuota(userId: number, plan: PlanTier | undefined, metric: "obfuscations" | "scripts" | "keys") {
  const selected = PLAN_DEFINITIONS.find((item) => item.id === (plan ?? "free")) ?? PLAN_DEFINITIONS[0];
  const limit = selected[metric];
  if (limit === "unlimited") return;
  const usage = await getWorkspaceUsage(userId);
  const current = metric === "obfuscations" ? usage.protections : metric === "scripts" ? usage.scripts : usage.keys;
  if (current >= limit) throw new TRPCError({ code: "FORBIDDEN", message: `Has alcanzado el límite de ${selected.label} para ${metric}.` });
}


const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function generateNormalKeyCode() { let key = ""; for (let index = 0; index < 32; index += 1) key += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length)]; return key; }
function generatePlanKeyCode(plan: PlanTier) {
  const prefix = plan.toUpperCase();
  let suffix = "";
  for (let index = 0; index < 16; index += 1) suffix += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

const protectionInput = z.object({
  name: z.string().trim().min(1).max(255),
  source: z.string().min(1).max(150_000),
  mode: z.enum(["fast", "balanced", "fortified"]),
  obfuscateStrings: z.boolean(),
  addLoaderGuard: z.boolean(),
  discordChannelId: z.string().trim().regex(/^\d{15,22}$/).optional(),
});

function toClientRecord(row: NonNullable<Awaited<ReturnType<typeof createProtection>>>) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    checksum: row.checksum,
    code: row.resultCode ?? "",
    createdAt: row.createdAt.toISOString(),
    message: row.message ?? "",
  };
}

export const appRouter = router({
  system: systemRouter,
  discord: router({
    status: publicProcedure.query(async () => {
      const gateway = getDiscordGatewayStatus();
      if (gateway.online) return { online: true, state: "online" as const, username: gateway.username };
      const identity = await getDiscordBotIdentity();
      return identity ? { online: false, state: "connecting" as const, username: identity.username } : { online: false, state: gateway.configured ? "offline" as const : "not_configured" as const, username: null };
    }),
    updateChannel: protectedProcedure.input(z.object({ discordChannelId: z.string().regex(/^\d{15,22}$/).nullable() })).mutation(async ({ ctx, input }) => { if (input.discordChannelId) { const check = await checkDiscordChannel(input.discordChannelId); if (!check.ok) { await updateDiscordChannelId(ctx.user.id, null); return { ok: false as const, status: check.status ?? null, message: check.message }; } } await updateDiscordChannelId(ctx.user.id, input.discordChannelId); return { ok: true as const, channelId: input.discordChannelId }; }),
    updateContentChannels: protectedProcedure.input(z.object({ pricesChannelId: z.string().regex(/^\d{15,22}$/).nullable().optional(), updatesChannelId: z.string().regex(/^\d{15,22}$/).nullable().optional() })).mutation(async ({ ctx, input }) => { const channels = [input.pricesChannelId, input.updatesChannelId].filter((value): value is string => Boolean(value)); for (const channelId of channels) { const check = await checkDiscordChannel(channelId); if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message }); } await updateDiscordContentChannels(ctx.user.id, input); return { ok: true as const, pricesChannelId: input.pricesChannelId ?? null, updatesChannelId: input.updatesChannelId ?? null }; }),
    createPanel: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(255), description: z.string().trim().max(1000).optional(), channelId: z.string().regex(/^\d{15,22}$/), targetScript: z.string().trim().min(1).max(255), hwidHours: z.number().int().min(0).max(720).default(24) })).mutation(async ({ ctx, input }) => { const check = await checkDiscordChannel(input.channelId); if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message }); const script = await getHostedScriptByName(ctx.user.id, input.targetScript); if (!script) throw new TRPCError({ code: "NOT_FOUND", message: "Selecciona un script hosteado de tu workspace." }); const result = await publishDiscordPanel(input.channelId, { name: input.name, description: input.description, script: script.name, hwidHours: input.hwidHours, ownerId: ctx.user.id, hostedScriptId: script.id }); await updateDiscordChannelId(ctx.user.id, input.channelId); return createDiscordPanel({ ownerId: ctx.user.id, name: input.name, description: input.description ?? null, channelId: input.channelId, targetScript: script.name, hwidHours: input.hwidHours, messageId: result.messageId }); }),
    listPanels: protectedProcedure.query(({ ctx }) => getDiscordPanelsByOwner(ctx.user.id)),
    deletePanel: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const rows = await getDiscordPanelsByOwner(ctx.user.id); const panel = rows.find((item) => item.id === input.id); if (!panel) throw new TRPCError({ code: "NOT_FOUND", message: "Panel no encontrado." }); if (panel.messageId) await deletePublishedPanel(panel.channelId, panel.messageId); const { deleteDiscordPanel } = await import("./db"); await deleteDiscordPanel(ctx.user.id, panel.id); return { success: true as const }; }),
    republishPanel: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const rows = await getDiscordPanelsByOwner(ctx.user.id); const panel = rows.find((item) => item.id === input.id); if (!panel) throw new TRPCError({ code: "NOT_FOUND", message: "Panel no encontrado." }); const script = await getHostedScriptByName(ctx.user.id, panel.targetScript); if (!script) throw new TRPCError({ code: "NOT_FOUND", message: "El script de este panel ya no pertenece a tu workspace." }); const result = await publishDiscordPanel(panel.channelId, { name: panel.name, description: panel.description ?? undefined, script: script.name, hwidHours: panel.hwidHours, ownerId: ctx.user.id, hostedScriptId: script.id }); return result; }),
    publishPrices: protectedProcedure.input(z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(4000), channelId: z.string().regex(/^\d{15,22}$/) })).mutation(async ({ ctx, input }) => { const channelId = input.channelId; const check = await checkDiscordChannel(channelId); if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message }); return publishPricesMessage(channelId, { title: input.title, description: input.description }); }),
    publishUpdates: protectedProcedure.input(z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(4000), channelId: z.string().regex(/^\d{15,22}$/) })).mutation(async ({ ctx, input }) => { const channelId = input.channelId; const check = await checkDiscordChannel(channelId); if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.message }); return publishUpdatesMessage(channelId, { title: input.title, description: input.description }); }),
  }),
  workspace: router({
    usage: protectedProcedure.query(async ({ ctx }) => {
      const usage = await getWorkspaceUsage(ctx.user.id);
      const plan = ((ctx.user as typeof ctx.user & { plan?: PlanTier }).plan ?? "free") as PlanTier;
      return { plan, ...usage };
    }),
  }),
  plans: router({
    redeem: protectedProcedure.input(z.object({ keyCode: z.string().trim().toUpperCase().regex(/^(?:PRO|PREMIUM)-[a-z0-9]{16}$/i) })).mutation(async ({ ctx, input }) => {
      const result = await redeemPlanKey(ctx.user.id, input.keyCode);
      if (!result) throw new TRPCError({ code: "BAD_REQUEST", message: "Owner Key inválida, expirada, ya utilizada o no disponible." });
      return result;
    }),
  }),
  auth: router({
    me: publicProcedure.query(async opts => {
      const user = opts.ctx.user;
      if (!user) return user;
      const apiKey = await ensureUserApiKey(user.id);
      return { ...user, apiKey, isOwner: Boolean(ENV.ownerOpenId && user.openId === ENV.ownerOpenId && user.role === "admin") };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  hostedScripts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const origin = `${ctx.req.protocol}://${ctx.req.get("host")}`;
      const rows = await getHostedScriptsByUser(ctx.user.id);
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description ?? "",
        ffaMode: Boolean(row.ffaMode),
        createdAt: row.createdAt.toISOString(),
        url: `${origin}/scripts/hosted/${row.slug}`,
        loader: buildRuntimeLoader(`${origin}/scripts/hosted/${row.slug}`, row.scriptKey, Boolean(row.ffaMode)),
        scriptKey: row.scriptKey,
      }));
    }),
    source: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const row = await getHostedScriptSourceByUser(ctx.user.id, input.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Script no encontrado." });
      return row;
    }),
    update: protectedProcedure.input(hostedScriptInput.safeExtend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const existing = await getHostedScriptById(input.id);
      if (!existing || existing.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Script no encontrado." });
      const source = decodeHostedSource(input);
      const artifact = await protectWithAdapter(source, { mode: "balanced", obfuscateStrings: input.obfuscateSource, addLoaderGuard: true });
      const row = await updateHostedScript(ctx.user.id, input.id, { name: input.name, description: input.description || null, ffaMode: input.ffaMode ? 1 : 0, scriptKey: input.scriptKey || null, code: artifact.code, sourceCode: source });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Script no encontrado." });
      return { id: row.id, slug: row.slug, name: row.name, description: row.description ?? "", ffaMode: Boolean(row.ffaMode), createdAt: row.createdAt.toISOString(), url: `${ctx.req.protocol}://${ctx.req.get("host")}/scripts/hosted/${row.slug}`, loader: buildRuntimeLoader(`${ctx.req.protocol}://${ctx.req.get("host")}/scripts/hosted/${row.slug}`, row.scriptKey, Boolean(row.ffaMode)), scriptKey: row.scriptKey };
    }),
    remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const existing = await getHostedScriptById(input.id);
      if (!existing || existing.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Script no encontrado." });
      await deleteHostedScript(ctx.user.id, input.id);
      return { success: true as const };
    }),
    create: protectedProcedure.input(hostedScriptInput).mutation(async ({ ctx, input }) => {
      await assertWorkspaceQuota(ctx.user.id, (ctx.user as typeof ctx.user & { plan?: PlanTier }).plan, "scripts");
      const source = decodeHostedSource(input);
      const artifact = await protectWithAdapter(source, {
        mode: "balanced",
        obfuscateStrings: input.obfuscateSource,
        addLoaderGuard: true,
      });
      const slug = nanoid(18);
      const row = await createHostedScript({
        userId: ctx.user.id,
        slug,
        name: input.name,
        description: input.description || null,
        ffaMode: input.ffaMode ? 1 : 0,
        scriptKey: input.scriptKey || null,
        code: artifact.code,
        sourceCode: source,
      });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No se pudo alojar el script." });
      const origin = `${ctx.req.protocol}://${ctx.req.get("host")}`;
      const url = `${origin}/scripts/hosted/${row.slug}`;
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description ?? "",
        ffaMode: Boolean(row.ffaMode),
        createdAt: row.createdAt.toISOString(),
        url,
        loader: buildRuntimeLoader(url, row.scriptKey, Boolean(row.ffaMode)),
        scriptKey: row.scriptKey,
      };
    }),
  }),

  owner: router({
    publishedScripts: ownerProcedure.query(async () => {
      const rows = await getPublishedScriptsForOwnerReview();
      return rows.map(({ script, ownerName, ownerOpenId, discordUserId, discordUsername }) => {
        const source = script.sourceCode ?? "";
        return {
          id: script.id,
          ownerId: script.userId,
          ownerName: ownerName ?? "Usuario sin nombre",
          ownerOpenId,
          discordUserId,
          discordUsername,
          name: script.name,
          description: script.description ?? "",
          slug: script.slug,
          source,
          sourceSize: Buffer.byteLength(source, "utf8"),
          sourceHash: createHash("sha256").update(source, "utf8").digest("hex"),
          createdAt: script.createdAt.toISOString(),
          updatedAt: script.updatedAt.toISOString(),
        };
      });
    }),
  }),
  licenseKeys: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await getLicensesByOwner(ctx.user.id);
      return rows.filter((row) => !/^(?:PRO|PREMIUM)-/i.test(row.keyCode));
    }),
    generate: protectedProcedure.input(licenseInput).mutation(async ({ ctx, input }) => {
      if (input.keyKind === "plan" && !(ENV.ownerOpenId && ctx.user.openId === ENV.ownerOpenId && ctx.user.role === "admin")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Solo el owner puede generar Plan Keys." });
      }
      if (input.keyKind === "normal" && !input.hostedScriptId) throw new TRPCError({ code: "BAD_REQUEST", message: "Selecciona el script hosteado para esta key." });
      if (input.keyKind === "normal") {
        const script = await getHostedScriptByOwnerId(ctx.user.id, input.hostedScriptId!);
        if (!script || script.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Ese script no pertenece a tu cuenta." });
      }
      await assertWorkspaceQuota(ctx.user.id, (ctx.user as typeof ctx.user & { plan?: PlanTier }).plan, "keys");
      const durationDays = input.durationValue ? durationToDays(input.durationValue, input.durationUnit as DurationUnit) : undefined;
      const expiresAt = durationDays ? new Date(Date.now() + durationDays * 86_400_000) : null;
      const row = await createLicense({ ownerId: ctx.user.id, plan: input.keyKind === "plan" ? input.plan : "free", hostedScriptId: input.hostedScriptId ?? null, keyCode: input.keyKind === "plan" ? generatePlanKeyCode(input.plan) : generateNormalKeyCode(), type: input.type, status: "active", discordUserId: input.discordUserId ?? null, hwid: null, expiresAt });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No se pudo generar la licencia." });
      return row;
    }),
    revoke: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => revokeLicense(ctx.user.id, input.id)),
    remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => deleteLicense(ctx.user.id, input.id)),
    resetHwid: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const result = await resetLicenseHwid(ctx.user.id, input.id);
      if (!result.reset && result.reason === "cooldown") {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `El HWID ya fue reiniciado. Podrás volver a hacerlo el ${result.retryAt.toLocaleString()}.` });
      }
      if (!result.reset) throw new TRPCError({ code: "NOT_FOUND", message: "No se encontró una licencia activa para ese usuario." });
      return result;
    }),
  }),

  planKeys: ownerProcedure.query(async ({ ctx }) => {
    const rows = await getLicensesByOwner(ctx.user.id);
    return rows.filter((row) => /^(?:PRO|PREMIUM)-/i.test(row.keyCode));
  }),

  access: router({
    blacklist: router({
      list: protectedProcedure.query(({ ctx }) => getBlacklistsByOwner(ctx.user.id)),
      add: protectedProcedure.input(blacklistInput).mutation(async ({ ctx, input }) => {
        const script = await getHostedScriptByOwnerId(ctx.user.id, input.hostedScriptId);
        if (!script) throw new TRPCError({ code: "NOT_FOUND", message: "Ese script no pertenece a tu cuenta." });
        return createBlacklist({ ownerId: ctx.user.id, hostedScriptId: script.id, discordUserId: input.discordUserId, reason: input.reason ?? null, active: 1 });
      }),
      remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => deleteBlacklist(ctx.user.id, input.id)),
    }),
    whitelist: router({
      list: protectedProcedure.query(({ ctx }) => getAccessRulesByOwner(ctx.user.id)),
      add: protectedProcedure.input(accessRuleInput).mutation(async ({ ctx, input }) => {
        const script = await getHostedScriptByOwnerId(ctx.user.id, input.hostedScriptId);
        if (!script) throw new TRPCError({ code: "NOT_FOUND", message: "Ese script no pertenece a tu cuenta." });
        return createAccessRule({ ownerId: ctx.user.id, hostedScriptId: script.id, kind: input.kind, discordId: input.discordId, label: input.label ?? null, active: 1 });
      }),
      remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => deleteAccessRule(ctx.user.id, input.id)),
    }),
    logs: router({
      list: ownerProcedure.query(({ ctx }) => getKeyAuditLogsByOwner(ctx.user.id)),
      clear: ownerProcedure.mutation(({ ctx }) => deleteKeyAuditLogsByOwner(ctx.user.id)),
    }),
  }),

  protections: router({
    providerStatus: publicProcedure.query(() => ({ ...getProviderStatus(), adapter: getProtectionAdapterStatus() })),

    history: protectedProcedure.query(async ({ ctx }) => {
      const rows = await getProtectionsByUser(ctx.user.id);
      return rows.map(toClientRecord);
    }),

    create: protectedProcedure.input(protectionInput).mutation(async ({ ctx, input }) => {
      await assertWorkspaceQuota(ctx.user.id, (ctx.user as typeof ctx.user & { plan?: PlanTier }).plan, "obfuscations");
      const channelId = input.discordChannelId ?? ctx.user.discordChannelId ?? undefined;
      if (input.discordChannelId && input.discordChannelId !== ctx.user.discordChannelId) {
        await updateDiscordChannelId(ctx.user.id, input.discordChannelId);
      }
      let artifact;
      try {
        artifact = await protectWithAdapter(input.source, {
          mode: input.mode,
          obfuscateStrings: input.obfuscateStrings,
          addLoaderGuard: input.addLoaderGuard,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error desconocido durante la protección.";
        const failed = await createProtection({
          userId: ctx.user.id,
          name: input.name,
          sourceSize: Buffer.byteLength(input.source, "utf8"),
          status: "failed",
          mode: input.mode,
          obfuscateStrings: input.obfuscateStrings ? 1 : 0,
          addLoaderGuard: input.addLoaderGuard ? 1 : 0,
          checksum: "0000000000000000",
          resultCode: null,
          message,
        });
        const alert = {
          title: "Vanta.vs Protector: protección fallida",
          content: `La protección de ${input.name} falló para ${ctx.user.name ?? ctx.user.email ?? "un usuario"}. Motivo: ${message}`,
        };
        const [ownerSent, discordSent] = await Promise.all([
          notifyOwner(alert).catch(() => false),
          sendDiscordChannelMessage(channelId, alert),
        ]);
        if (!ownerSent && !discordSent) console.error("[Alerts] All notification channels failed for protection error");
        if (!failed) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No se pudo registrar el fallo." });
        return toClientRecord(failed);
      }

      const row = await createProtection({
        userId: ctx.user.id,
        name: input.name,
        sourceSize: Buffer.byteLength(input.source, "utf8"),
        status: artifact.status,
        mode: input.mode,
        obfuscateStrings: input.obfuscateStrings ? 1 : 0,
        addLoaderGuard: input.addLoaderGuard ? 1 : 0,
        checksum: artifact.checksum,
        resultCode: artifact.code,
        message: artifact.message,
      });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "No se pudo guardar la protección." });

      if (artifact.status === "review") {
        const alert = {
          title: "Vanta.vs Protector: revisión requerida",
          content: `La protección ${input.name} requiere revisión preventiva. Checksum: ${artifact.checksum}. Usuario: ${ctx.user.name ?? ctx.user.email ?? "desconocido"}.`,
        };
        const [ownerSent, discordSent] = await Promise.all([
          notifyOwner(alert).catch(() => false),
          sendDiscordChannelMessage(channelId, alert),
        ]);
        if (!ownerSent && !discordSent) console.error("[Alerts] All notification channels failed for review");
      }
      return toClientRecord(row);
    }),
  }),
});

export type AppRouter = typeof appRouter;
