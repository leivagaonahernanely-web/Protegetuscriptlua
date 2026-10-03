export type PlanTier = "free" | "pro" | "premium";

export type PlanDefinition = {
  id: PlanTier;
  label: string;
  obfuscations: number;
  scripts: number;
  keys: number | "unlimited";
  accent: string;
};

export const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  { id: "free", label: "Free Plan", obfuscations: 20, scripts: 6, keys: 500, accent: "#9ca3af" },
  { id: "pro", label: "Pro Plan", obfuscations: 120, scripts: 15, keys: 5_000, accent: "#5865f2" },
  { id: "premium", label: "Premium Plan", obfuscations: 1_000, scripts: 30, keys: "unlimited", accent: "#f0b232" },
];

export function formatPlanLimit(value: number | "unlimited") {
  return value === "unlimited" ? "Ilimitadas" : value.toLocaleString("en-US");
}

export function buildPlansDescription() {
  return PLAN_DEFINITIONS.map((plan) => [
    `**${plan.label}**`,
    `• ${formatPlanLimit(plan.obfuscations)} obfuscaciones`,
    `• ${formatPlanLimit(plan.scripts)} scripts`,
    `• ${formatPlanLimit(plan.keys)} keys`,
  ].join("\n")).join("\n\n");
}
