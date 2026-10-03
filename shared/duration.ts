export type DurationUnit = "days" | "months" | "years";

export const durationUnitLabels: Record<DurationUnit, string> = {
  days: "días",
  months: "meses",
  years: "años",
};

export function durationToMs(value: number, unit: DurationUnit) {
  const multipliers: Record<DurationUnit, number> = {
    days: 86_400_000,
    months: 30 * 86_400_000,
    years: 365 * 86_400_000,
  };
  return value > 0 && Number.isFinite(value) ? value * multipliers[unit] : undefined;
}

export function durationToDays(value: number, unit: DurationUnit) {
  return unit === "days" ? value : unit === "months" ? value * 30 : value * 365;
}
