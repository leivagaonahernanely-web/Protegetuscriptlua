import { and, count, desc, eq, isNull, lt, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { accessRules, blacklists, discordPanels, hostedScripts, HostedScript, InsertHostedScript, InsertLicense, InsertProtection, InsertUser, keyAuditLogs, licenses, protections, users, warnings } from "../drizzle/schema";
import { ENV } from './_core/env';
import { randomBytes } from "node:crypto";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod", "discordChannelId", "discordUserId", "discordUsername", "discordNickname", "discordAvatarUrl"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function createProtection(protection: InsertProtection) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(protections).values(protection);
  const insertedId = Number(result[0].insertId);
  const rows = await db.select().from(protections).where(eq(protections.id, insertedId)).limit(1);
  return rows[0];
}

export async function getProtectionsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(protections).where(eq(protections.userId, userId)).orderBy(desc(protections.createdAt)).limit(50);
}

function createApiKey() {
  return `VANTA-${randomBytes(24).toString("base64url")}`;
}

export async function ensureUserApiKey(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select({ id: users.id, apiKey: users.apiKey }).from(users).where(eq(users.id, userId)).limit(1);
  const current = rows[0];
  if (!current) return undefined;
  if (current.apiKey) return current.apiKey;
  const apiKey = createApiKey();
  await db.update(users).set({ apiKey }).where(and(eq(users.id, userId), isNull(users.apiKey)));
  const updated = await db.select({ apiKey: users.apiKey }).from(users).where(eq(users.id, userId)).limit(1);
  return updated[0]?.apiKey ?? apiKey;
}

export async function getApiKeyByDiscordUserId(discordUserId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ id: users.id, apiKey: users.apiKey }).from(users).where(eq(users.discordUserId, discordUserId)).limit(1);
  const user = rows[0];
  if (!user) return undefined;
  return { userId: user.id, apiKey: user.apiKey ?? await ensureUserApiKey(user.id) };
}

export async function getBuyerRoleId(ownerId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ buyerRoleId: users.buyerRoleId }).from(users).where(eq(users.id, ownerId)).limit(1);
  return rows[0]?.buyerRoleId ?? undefined;
}

export async function setBuyerRoleId(ownerId: number, buyerRoleId: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ buyerRoleId }).where(eq(users.id, ownerId));
  return buyerRoleId;
}

export async function updateDiscordChannelId(userId: number, discordChannelId: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ discordChannelId }).where(eq(users.id, userId));
}

export async function updateDiscordContentChannels(userId: number, channels: { pricesChannelId?: string | null; updatesChannelId?: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set(channels).where(eq(users.id, userId));
}

export async function linkDiscordIdentity(userId: number, discordUserId: string, discordUsername: string, discordNickname?: string | null, discordAvatarUrl?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(users).set({ discordUserId, discordUsername, discordNickname: discordNickname ?? null, discordAvatarUrl: discordAvatarUrl ?? null }).where(eq(users.id, userId));
}

export async function createHostedScript(input: InsertHostedScript): Promise<HostedScript | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(hostedScripts).values(input);
  const insertedId = Number(result[0].insertId);
  const rows = await db.select().from(hostedScripts).where(eq(hostedScripts.id, insertedId)).limit(1);
  return rows[0];
}

export async function getHostedScriptsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostedScripts).where(eq(hostedScripts.userId, userId)).orderBy(desc(hostedScripts.createdAt)).limit(50);
}

/** Owner-only review feed. It intentionally returns original sourceCode only to the server-side owner procedure. */
export async function getPublishedScriptsForOwnerReview() {
  const db = await getDb();
  if (!db) return [];
  return db.select({
    script: hostedScripts,
    ownerName: users.name,
    ownerOpenId: users.openId,
    discordUserId: users.discordUserId,
    discordUsername: users.discordUsername,
  }).from(hostedScripts).leftJoin(users, eq(hostedScripts.userId, users.id)).orderBy(desc(hostedScripts.createdAt)).limit(200);
}

export async function getWorkspaceUsage(userId: number) {
  const db = await getDb();
  if (!db) return { protections: 0, scripts: 0, keys: 0 };
  const [protectionRows, scriptRows, licenseRows] = await Promise.all([
    db.select({ value: count() }).from(protections).where(eq(protections.userId, userId)),
    db.select({ value: count() }).from(hostedScripts).where(eq(hostedScripts.userId, userId)),
    db.select({ value: count() }).from(licenses).where(eq(licenses.ownerId, userId)),
  ]);
  return { protections: Number(protectionRows[0]?.value ?? 0), scripts: Number(scriptRows[0]?.value ?? 0), keys: Number(licenseRows[0]?.value ?? 0) };
}

export async function getHostedScriptById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(hostedScripts).where(eq(hostedScripts.id, id)).limit(1);
  return rows[0];
}

export async function getHostedScriptByOwnerId(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(hostedScripts).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, ownerId))).limit(1);
  return rows[0];
}

export async function updateHostedScript(ownerId: number, id: number, input: Partial<InsertHostedScript>) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(hostedScripts).set(input).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, ownerId)));
  const rows = await db.select().from(hostedScripts).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, ownerId))).limit(1);
  return rows[0];
}

export async function deleteHostedScript(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const script = await db.select({ id: hostedScripts.id }).from(hostedScripts).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, ownerId))).limit(1);
  if (!script[0]) return false;
  await db.delete(licenses).where(and(eq(licenses.ownerId, ownerId), eq(licenses.hostedScriptId, id)));
  await db.delete(accessRules).where(and(eq(accessRules.ownerId, ownerId), eq(accessRules.hostedScriptId, id)));
  await db.delete(hostedScripts).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, ownerId)));
  return true;
}

export async function getHostedScriptBySlug(slug: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(hostedScripts).where(eq(hostedScripts.slug, slug)).limit(1);
  return rows[0];
}

export async function getActiveLicenseForHostedScript(hostedScriptId: number, keyCode: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(licenses).where(and(eq(licenses.keyCode, keyCode), eq(licenses.status, "active"), or(eq(licenses.hostedScriptId, hostedScriptId), isNull(licenses.hostedScriptId)))).limit(1);
  const license = rows[0];
  if (!license || (license.expiresAt && license.expiresAt.getTime() <= Date.now())) return undefined;
  return license;
}

export async function isDiscordUserBlacklistedForScript(ownerId: number, hostedScriptId: number, discordUserId: string) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: blacklists.id }).from(blacklists).where(and(
    eq(blacklists.ownerId, ownerId),
    eq(blacklists.hostedScriptId, hostedScriptId),
    eq(blacklists.discordUserId, discordUserId),
    eq(blacklists.active, 1),
  )).limit(1);
  return Boolean(rows[0]);
}

export async function claimLicenseHwid(hostedScriptId: number, keyCode: string, hwid: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(licenses).where(and(eq(licenses.keyCode, keyCode), eq(licenses.status, "active"), or(eq(licenses.hostedScriptId, hostedScriptId), isNull(licenses.hostedScriptId)))).limit(1);
  const license = rows[0];
  if (!license || (license.expiresAt && license.expiresAt.getTime() <= Date.now())) return undefined;
  if (!license.discordUserId) return undefined;
  if (await isDiscordUserBlacklistedForScript(license.ownerId, hostedScriptId, license.discordUserId)) return undefined;
  if (license.hwid && license.hwid !== hwid) return undefined;
  if (!license.hwid) {
    const result = await db.update(licenses).set({ hwid }).where(and(eq(licenses.id, license.id), isNull(licenses.hwid), eq(licenses.status, "active"), eq(licenses.discordUserId, license.discordUserId)));
    if (Number(result[0]?.affectedRows ?? 0) === 0) {
      const current = await db.select().from(licenses).where(eq(licenses.id, license.id)).limit(1);
      const claimed = current[0];
      if (!claimed || claimed.status !== "active" || claimed.hwid !== hwid) return undefined;
      return claimed;
    }
  }
  return { ...license, hwid };
}

export async function createLicense(input: InsertLicense) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(licenses).values(input);
  const rows = await db.select().from(licenses).where(eq(licenses.id, Number(result[0].insertId))).limit(1);
  return rows[0];
}

export async function getLicenseById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(licenses).where(eq(licenses.id, id)).limit(1);
  return rows[0];
}

export async function getLicensesByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(licenses).where(eq(licenses.ownerId, ownerId)).orderBy(desc(licenses.createdAt)).limit(100);
}

export async function getActiveLicensesByDiscordUserId(discordUserId: string, ownerId?: number) {
  const db = await getDb();
  if (!db) return [];
  const filters = [eq(licenses.discordUserId, discordUserId), eq(licenses.status, "active")];
  if (ownerId !== undefined) filters.push(eq(licenses.ownerId, ownerId));
  return db.select().from(licenses).where(and(...filters)).orderBy(desc(licenses.createdAt)).limit(100);
}

export async function revokeLicense(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.update(licenses).set({ status: "revoked" }).where(and(eq(licenses.id, id), eq(licenses.ownerId, ownerId)));
}

export async function resetLicenseHwid(ownerId: number, id: number, bypassCooldown = false) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select({ id: licenses.id, hwidResetAt: licenses.hwidResetAt }).from(licenses).where(and(eq(licenses.id, id), eq(licenses.ownerId, ownerId), eq(licenses.status, "active"))).limit(1);
  const license = rows[0];
  if (!license) return { reset: false as const, reason: "not_found" as const };
  const cooldownMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (!bypassCooldown && license.hwidResetAt && now - license.hwidResetAt.getTime() < cooldownMs) {
    return { reset: false as const, reason: "cooldown" as const, retryAt: new Date(license.hwidResetAt.getTime() + cooldownMs) };
  }
  const filters = [eq(licenses.id, id), eq(licenses.ownerId, ownerId), eq(licenses.status, "active")];
  if (!bypassCooldown) filters.push(or(isNull(licenses.hwidResetAt), lt(licenses.hwidResetAt, new Date(now - cooldownMs)))!);
  const result = await db.update(licenses).set({ hwid: null, hwidResetAt: new Date(now) }).where(and(...filters));
  if (Number(result[0]?.affectedRows ?? 0) === 0) {
    return { reset: false as const, reason: "cooldown" as const, retryAt: new Date(now + cooldownMs) };
  }
  return { reset: true as const, resetAt: new Date(now) };
}

export async function deleteLicense(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(licenses).where(and(eq(licenses.id, id), eq(licenses.ownerId, ownerId)));
}

export async function getAccessRulesByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(accessRules).where(and(eq(accessRules.ownerId, ownerId), ne(accessRules.label, "__key_manager__"))).orderBy(desc(accessRules.createdAt)).limit(100);
}

export async function createAccessRule(input: typeof accessRules.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(accessRules).values(input);
  const rows = await db.select().from(accessRules).where(eq(accessRules.id, Number(result[0].insertId))).limit(1);
  return rows[0];
}

export async function deleteAccessRule(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(accessRules).where(and(eq(accessRules.id, id), eq(accessRules.ownerId, ownerId)));
}

export async function getBlacklistsByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(blacklists).where(eq(blacklists.ownerId, ownerId)).orderBy(desc(blacklists.createdAt)).limit(100);
}

export async function createBlacklist(input: typeof blacklists.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(blacklists).values(input);
  const rows = await db.select().from(blacklists).where(eq(blacklists.id, Number(result[0].insertId))).limit(1);
  return rows[0];
}

export async function deleteBlacklist(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(blacklists).where(and(eq(blacklists.id, id), eq(blacklists.ownerId, ownerId)));
}


export async function getUserByDiscordUserId(discordUserId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(users).where(eq(users.discordUserId, discordUserId)).limit(1);
  return rows[0];
}

export async function getKeyManagerRoleId(ownerId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(accessRules).where(and(eq(accessRules.ownerId, ownerId), eq(accessRules.kind, "role"), eq(accessRules.label, "__key_manager__"))).limit(1);
  return rows[0]?.discordId;
}

export async function setKeyManagerRole(ownerId: number, discordRoleId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(accessRules).where(and(eq(accessRules.ownerId, ownerId), eq(accessRules.kind, "role"), eq(accessRules.label, "__key_manager__")));
  await db.insert(accessRules).values({ ownerId, kind: "role", discordId: discordRoleId, label: "__key_manager__", active: 1 });
  return discordRoleId;
}

export async function redeemLicense(keyCode: string, discordUserId: string, scope?: { ownerId?: number; hostedScriptId?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const filters = [eq(licenses.keyCode, keyCode)];
  if (scope?.ownerId !== undefined) filters.push(eq(licenses.ownerId, scope.ownerId));
  if (scope?.hostedScriptId !== undefined) filters.push(eq(licenses.hostedScriptId, scope.hostedScriptId));
  const rows = await db.select().from(licenses).where(and(...filters)).limit(1);
  const license = rows[0];
  if (!license || license.status !== "active" || (license.expiresAt && license.expiresAt.getTime() <= Date.now())) return undefined;
  if (license.discordUserId && license.discordUserId !== discordUserId) return undefined;
  await db.update(licenses).set({ discordUserId }).where(eq(licenses.id, license.id));
  return { ...license, discordUserId };
}

export async function redeemPlanKey(userId: number, keyCode: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select().from(licenses).where(and(eq(licenses.keyCode, keyCode), eq(licenses.status, "active"), isNull(licenses.hostedScriptId))).limit(1);
  const license = rows[0];
  if (!license || license.type !== "license" || !["pro", "premium"].includes(license.plan)) return undefined;
  if (license.expiresAt && license.expiresAt.getTime() <= Date.now()) return undefined;
  await db.update(users).set({ plan: license.plan, updatedAt: new Date() }).where(eq(users.id, userId));
  await db.update(licenses).set({ status: "revoked", discordUserId: String(userId) }).where(and(eq(licenses.id, license.id), eq(licenses.status, "active")));
  return { plan: license.plan, keyCode: license.keyCode };
}

export async function deleteLicenseByKeyCode(ownerId: number, keyCode: string) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.delete(licenses).where(and(eq(licenses.ownerId, ownerId), eq(licenses.keyCode, keyCode)));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function resetLicenseHwidByDiscordUserId(discordUserId: string, bypassCooldown = false, scope?: { ownerId?: number; hostedScriptId?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const selectFilters = [eq(licenses.discordUserId, discordUserId), eq(licenses.status, "active")];
  if (scope?.ownerId !== undefined) selectFilters.push(eq(licenses.ownerId, scope.ownerId));
  if (scope?.hostedScriptId !== undefined) selectFilters.push(eq(licenses.hostedScriptId, scope.hostedScriptId));
  const rows = await db.select({ id: licenses.id, hwidResetAt: licenses.hwidResetAt }).from(licenses).where(and(...selectFilters)).limit(100);
  if (rows.length === 0) return { reset: false as const, reason: "not_found" as const };
  const cooldownMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (!bypassCooldown) {
    const blocked = rows.find((row) => row.hwidResetAt && now - row.hwidResetAt.getTime() < cooldownMs);
    if (blocked?.hwidResetAt) return { reset: false as const, reason: "cooldown" as const, retryAt: new Date(blocked.hwidResetAt.getTime() + cooldownMs) };
  }
  const filters = [eq(licenses.discordUserId, discordUserId), eq(licenses.status, "active")];
  if (scope?.ownerId !== undefined) filters.push(eq(licenses.ownerId, scope.ownerId));
  if (scope?.hostedScriptId !== undefined) filters.push(eq(licenses.hostedScriptId, scope.hostedScriptId));
  if (!bypassCooldown) filters.push(or(isNull(licenses.hwidResetAt), lt(licenses.hwidResetAt, new Date(now - cooldownMs)))!);
  await db.update(licenses).set({ hwid: null, hwidResetAt: new Date(now) }).where(and(...filters));
  return { reset: true as const, resetAt: new Date(now), count: rows.length };
}

export async function getHostedScriptSourceByUser(userId: number, id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select({ id: hostedScripts.id, name: hostedScripts.name, code: hostedScripts.code, sourceCode: hostedScripts.sourceCode }).from(hostedScripts).where(and(eq(hostedScripts.id, id), eq(hostedScripts.userId, userId))).limit(1);
  const row = rows[0];
  return row ? { ...row, code: row.sourceCode ?? row.code } : undefined;
}

export async function deleteAccessRuleByDiscordId(ownerId: number, discordId: string, hostedScriptId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const filters = [eq(accessRules.ownerId, ownerId), eq(accessRules.discordId, discordId), ne(accessRules.label, "__key_manager__")];
  if (hostedScriptId) filters.push(eq(accessRules.hostedScriptId, hostedScriptId));
  const result = await db.delete(accessRules).where(and(...filters));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}

export async function createDiscordPanel(input: typeof discordPanels.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(discordPanels).values(input);
  const rows = await db.select().from(discordPanels).where(eq(discordPanels.id, Number(result[0].insertId))).limit(1);
  return rows[0];
}

export async function getDiscordPanelsByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(discordPanels).where(eq(discordPanels.ownerId, ownerId)).orderBy(desc(discordPanels.createdAt)).limit(50);
}

export async function deleteDiscordPanel(ownerId: number, id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select().from(discordPanels).where(and(eq(discordPanels.ownerId, ownerId), eq(discordPanels.id, id))).limit(1);
  if (!rows[0]) return undefined;
  await db.delete(discordPanels).where(and(eq(discordPanels.ownerId, ownerId), eq(discordPanels.id, id)));
  return rows[0];
}

export async function getHostedScriptByName(ownerId: number, name: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(hostedScripts).where(and(eq(hostedScripts.userId, ownerId), eq(hostedScripts.name, name))).limit(1);
  return rows[0];
}

export async function addTimeToLicense(ownerId: number, keyCode: string, durationMs: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select().from(licenses).where(and(eq(licenses.ownerId, ownerId), eq(licenses.keyCode, keyCode))).limit(1);
  const license = rows[0];
  if (!license) return undefined;
  const base = license.expiresAt && license.expiresAt.getTime() > Date.now() ? license.expiresAt.getTime() : Date.now();
  const expiresAt = new Date(base + durationMs);
  await db.update(licenses).set({ expiresAt, status: "active" }).where(eq(licenses.id, license.id));
  return { ...license, expiresAt };
}

export async function createWarning(input: typeof warnings.$inferInsert) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.insert(warnings).values(input);
  return { id: Number(result[0].insertId), ...input };
}

export async function createKeyAuditLog(input: { ownerId: number; actorDiscordId: string; action: "generate" | "delete"; keyCode: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.insert(keyAuditLogs).values(input);
}

export async function getKeyAuditLogsByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(keyAuditLogs).where(eq(keyAuditLogs.ownerId, ownerId)).orderBy(desc(keyAuditLogs.createdAt)).limit(200);
}

export async function deleteKeyAuditLogsByOwner(ownerId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(keyAuditLogs).where(eq(keyAuditLogs.ownerId, ownerId));
  return { success: true as const };
}

export async function createAccessRuleIfAbsent(input: { ownerId: number; hostedScriptId?: number | null; kind: "user" | "role"; discordId: string; label?: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const scriptFilter = input.hostedScriptId ? eq(accessRules.hostedScriptId, input.hostedScriptId) : isNull(accessRules.hostedScriptId);
  const existing = await db.select().from(accessRules).where(and(eq(accessRules.ownerId, input.ownerId), scriptFilter, eq(accessRules.kind, input.kind), eq(accessRules.discordId, input.discordId), eq(accessRules.active, 1))).limit(1);
  if (existing[0]) return { added: 0, alreadyWhitelisted: 1, failed: 0 };
  await db.insert(accessRules).values({ ownerId: input.ownerId, hostedScriptId: input.hostedScriptId ?? null, kind: input.kind, discordId: input.discordId, label: input.label ?? null, active: 1 });
  return { added: 1, alreadyWhitelisted: 0, failed: 0 };
}
