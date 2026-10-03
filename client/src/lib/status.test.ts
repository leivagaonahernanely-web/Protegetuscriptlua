import { describe, expect, it } from "vitest";
import { getBotStatusClass, getBotStatusLabel } from "./status";

describe("bot status presentation", () => {
  it("does not report offline while loading", () => {
    const status = { isLoading: true, isError: false } as const;
    expect(getBotStatusLabel(status)).toBe("BOT CONNECTING");
    expect(getBotStatusClass(status)).toBe("bot-connecting");
  });

  it("reports an unavailable status on query errors", () => {
    const status = { isLoading: false, isError: true } as const;
    expect(getBotStatusLabel(status)).toBe("BOT STATUS UNAVAILABLE");
    expect(getBotStatusClass(status)).toBe("bot-connecting");
  });

  it("includes the bot username when online", () => {
    const status = { isLoading: false, isError: false, online: true, username: "Protectorscripts" } as const;
    expect(getBotStatusLabel(status)).toBe("BOT ONLINE · Protectorscripts");
    expect(getBotStatusClass(status)).toBe("bot-online");
  });

  it("distinguishes connecting and not configured states", () => {
    expect(getBotStatusLabel({ isLoading: false, isError: false, state: "connecting" })).toBe("BOT CONNECTING");
    expect(getBotStatusLabel({ isLoading: false, isError: false, state: "not_configured" })).toBe("BOT NOT CONFIGURED");
  });
});
