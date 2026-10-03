import { describe, expect, it } from "vitest";
import { durationToMs } from "./duration";
import { parseDuration } from "../server/discordBot";

describe("shared license durations", () => {
  it.each([
    ["days", "30d", 30],
    ["months", "3months", 3],
    ["years", "1year", 1],
  ] as const)("keeps web and slash duration math equal for %s", (_unit, slashValue, value) => {
    const unit = _unit;
    expect(parseDuration(slashValue)).toBe(durationToMs(value, unit));
  });
});
