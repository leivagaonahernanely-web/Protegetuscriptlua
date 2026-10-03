import { describe, expect, it, vi } from "vitest";
import { getSoundPreference, playUiChime, setSoundPreference } from "./ui-sound";

function storageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("optional UI sound", () => {
  it("keeps sound disabled until the user opts in", () => {
    const storage = storageMock();
    expect(getSoundPreference(storage)).toBe(false);
    setSoundPreference(storage, true);
    expect(getSoundPreference(storage)).toBe(true);
    setSoundPreference(storage, false);
    expect(getSoundPreference(storage)).toBe(false);
  });

  it("does not try to play sound during server rendering or when disabled", () => {
    expect(playUiChime(false)).toBe(false);
    expect(playUiChime(true)).toBe(false);
  });

  it("plays a short chime only after an available browser audio context is supplied", () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const addEventListener = vi.fn((_: string, callback: () => void) => callback());
    const oscillator = { type: "", frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), addEventListener };
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createOscillator() { return oscillator; }
      createGain() { return gain; }
      close = close;
    }
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    expect(playUiChime(true)).toBe(true);
    expect(oscillator.start).toHaveBeenCalled();
    expect(oscillator.stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
