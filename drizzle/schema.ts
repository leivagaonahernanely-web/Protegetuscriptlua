import { int, mediumtext, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  plan: mysqlEnum("plan", ["free", "pro", "premium"]).default("free").notNull(),
  discordChannelId: varchar("discordChannelId", { length: 32 }),
  pricesChannelId: varchar("pricesChannelId", { length: 32 }),
  updatesChannelId: varchar("updatesChannelId", { length: 32 }),
  discordUserId: varchar("discordUserId", { length: 32 }),
  discordUsername: varchar("discordUsername", { length: 128 }),
  discordNickname: varchar("discordNickname", { length: 128 }),
  discordAvatarUrl: varchar("discordAvatarUrl", { length: 500 }),
  buyerRoleId: varchar("buyerRoleId", { length: 32 }),
  apiKey: varchar("apiKey", { length: 80 }).unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const protections = mysqlTable("protections", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  sourceSize: int("sourceSize").notNull(),
  status: mysqlEnum("status", ["protected", "review", "failed"]).default("protected").notNull(),
  mode: mysqlEnum("mode", ["fast", "balanced", "fortified"]).default("balanced").notNull(),
  obfuscateStrings: int("obfuscateStrings").default(1).notNull(),
  addLoaderGuard: int("addLoaderGuard").default(1).notNull(),
  checksum: varchar("checksum", { length: 16 }).notNull(),
  resultCode: text("resultCode"),
  message: text("message"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Protection = typeof protections.$inferSelect;
export type InsertProtection = typeof protections.$inferInsert;

export const hostedScripts = mysqlTable("hostedScripts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id),
  slug: varchar("slug", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  ffaMode: int("ffaMode").default(0).notNull(),
  scriptKey: varchar("scriptKey", { length: 128 }),
  code: mediumtext("code").notNull(),
  sourceCode: mediumtext("sourceCode"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type HostedScript = typeof hostedScripts.$inferSelect;
export type InsertHostedScript = typeof hostedScripts.$inferInsert;

export const licenses = mysqlTable("licenses", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  plan: mysqlEnum("plan", ["free", "pro", "premium"]).default("free").notNull(),
  hostedScriptId: int("hostedScriptId").references(() => hostedScripts.id),
  keyCode: varchar("keyCode", { length: 64 }).notNull().unique(),
  type: mysqlEnum("type", ["trial", "license"]).default("license").notNull(),
  status: mysqlEnum("status", ["active", "revoked", "expired"]).default("active").notNull(),
  discordUserId: varchar("discordUserId", { length: 32 }),
  hwid: varchar("hwid", { length: 128 }),
  hwidResetAt: timestamp("hwidResetAt"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type License = typeof licenses.$inferSelect;
export type InsertLicense = typeof licenses.$inferInsert;

export const accessRules = mysqlTable("accessRules", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  hostedScriptId: int("hostedScriptId").references(() => hostedScripts.id),
  kind: mysqlEnum("kind", ["user", "role"]).notNull(),
  discordId: varchar("discordId", { length: 32 }).notNull(),
  label: varchar("label", { length: 128 }),
  active: int("active").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const keyAuditLogs = mysqlTable("keyAuditLogs", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  actorDiscordId: varchar("actorDiscordId", { length: 32 }).notNull(),
  action: mysqlEnum("action", ["generate", "delete"]).notNull(),
  keyCode: varchar("keyCode", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const discordPanels = mysqlTable("discordPanels", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 1000 }),
  channelId: varchar("channelId", { length: 32 }).notNull(),
  targetScript: varchar("targetScript", { length: 255 }).notNull(),
  hwidHours: int("hwidHours").default(24).notNull(),
  messageId: varchar("messageId", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const warnings = mysqlTable("warnings", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  hostedScriptId: int("hostedScriptId").references(() => hostedScripts.id),
  discordUserId: varchar("discordUserId", { length: 32 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const blacklists = mysqlTable("blacklists", {
  id: int("id").autoincrement().primaryKey(),
  ownerId: int("ownerId").notNull().references(() => users.id),
  hostedScriptId: int("hostedScriptId").references(() => hostedScripts.id),
  discordUserId: varchar("discordUserId", { length: 32 }).notNull(),
  reason: varchar("reason", { length: 500 }),
  active: int("active").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
