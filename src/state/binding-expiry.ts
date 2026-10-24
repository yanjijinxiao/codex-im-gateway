/** Metadata on an existing IM binding, never another source of binding truth. */
export type BindingActivity = {
  generation: string;
  baselineAt: string;
  lastHumanAt?: string;
  idleDays?: number;
  policyBasisDays?: number;
  endedAt?: string;
  endedReason?: "manual" | "idle";
  endedSessionId?: string;
};
export type BindingExpiry = BindingActivity & {
  effectiveDays: number;
  inherited: boolean;
  expiresAt?: string;
  status: "unbound" | "disabled" | "scheduled" | "due" | "policy-pending";
};
export const DEFAULT_BINDING_IDLE_DAYS = 15;
export const DAY_MS = 86_400_000;
export const validIdleDays = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3650;
export const idleDays = (value: unknown): number => validIdleDays(value) ? value : DEFAULT_BINDING_IDLE_DAYS;
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function normalizeBindingActivity(value: unknown): BindingActivity | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Partial<BindingActivity>;
  if (typeof v.generation !== "string" || !v.generation || !validDate(v.baselineAt)) return;
  return { generation: v.generation, baselineAt: v.baselineAt,
    ...(validDate(v.lastHumanAt) ? { lastHumanAt: v.lastHumanAt } : {}),
    ...(validIdleDays(v.idleDays) ? { idleDays: v.idleDays } : {}),
    ...(validIdleDays(v.policyBasisDays) ? { policyBasisDays: v.policyBasisDays } : {}),
    ...(validDate(v.endedAt) ? { endedAt: v.endedAt } : {}),
    ...(typeof v.endedSessionId === "string" && v.endedSessionId ? { endedSessionId: v.endedSessionId } : {}),
    ...(v.endedReason === "idle" || v.endedReason === "manual" ? { endedReason: v.endedReason } : {}) };
}

export function bindingExpiry(activity: BindingActivity, bound: boolean, defaultDays: number, now = Date.now()): BindingExpiry {
  const effectiveDays = activity.idleDays ?? idleDays(defaultDays);
  const policyPending = activity.policyBasisDays !== effectiveDays;
  const expiresAt = bound && effectiveDays > 0 && !policyPending
    ? new Date(Math.max(Date.parse(activity.baselineAt), Date.parse(activity.lastHumanAt ?? activity.baselineAt)) + effectiveDays * DAY_MS).toISOString() : undefined;
  return { ...activity, effectiveDays, inherited: activity.idleDays === undefined, ...(expiresAt ? { expiresAt } : {}),
    status: !bound ? "unbound" : !effectiveDays ? "disabled" : policyPending ? "policy-pending"
      : expiresAt && Date.parse(expiresAt) <= now ? "due" : "scheduled" };
}
