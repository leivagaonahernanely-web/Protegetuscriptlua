const SOUND_STORAGE_KEY = "vanta.ui.sound";

export function getSoundPreference(storage?: Pick<Storage, "getItem">) {
  if (!storage) return false;
  return storage.getItem(SOUND_STORAGE_KEY) === "on";
}

export function setSoundPreference(storage: Pick<Storage, "setItem">, enabled: boolean) {
  storage.setItem(SOUND_STORAGE_KEY, enabled ? "on" : "off");
}

export function playUiChime(enabled: boolean) {
  if (!enabled || typeof window === "undefined") return false;
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return false;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(280, now);
  oscillator.frequency.exponentialRampToValueAtTime(360, now + 0.055);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.018, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.085);
  oscillator.addEventListener("ended", () => { void context.close(); });
  return true;
}
