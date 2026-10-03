import { describe, expect, it } from "vitest";
import { isTransientNetworkError, shouldRetryQuery } from "./query-retry";

describe("query network retry", () => {
  it("recognizes browser fetch failures", () => {
    expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientNetworkError(new Error("validation failed"))).toBe(false);
  });

  it("retries only transient network errors twice", () => {
    const error = new TypeError("Load failed");
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(false);
    expect(shouldRetryQuery(0, new Error("server validation"))).toBe(false);
  });
});
