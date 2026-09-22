/**
 * Plan tiers and feature gating (spec section 5).
 *
 * Two rules govern this file:
 *
 * 1. Gating is enforced server-side first, UI second. `assertFeature` throws;
 *    hiding a button is a courtesy, not a control.
 * 2. Pricing here is a placeholder. The spec's open questions call for a
 *    competitor feature audit before the numbers are settled, so treat
 *    `priceMonthly` and `includedJobsPerMonth` as provisional.
 */

export const PLAN_FEATURES = [
  "poc_pod_capture",
  "multi_vehicle_consignments",
  "leg_handover",
  "live_gps_tracking",
  "automatic_invoicing",
  "rate_cards",
  "analytics_dashboard",
  "multi_depot",
  "api_access",
  "white_labelling",
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

export type PlanFeatures = Record<PlanFeature, boolean>;

export interface PlanDefinition {
  /** Stable key. Never renamed once a company is on it. */
  key: string;
  name: string;
  /** GBP per month, excluding VAT. Provisional. */
  priceMonthly: number;
  /** Consignments included per billing period. null means unmetered. */
  includedJobsPerMonth: number | null;
  /** Charged per consignment beyond the included allowance. */
  overagePricePerJob: number | null;
  features: PlanFeatures;
}

function features(enabled: readonly PlanFeature[]): PlanFeatures {
  return Object.fromEntries(PLAN_FEATURES.map((f) => [f, enabled.includes(f)])) as PlanFeatures;
}

/**
 * Multi-vehicle consignments are available on every tier on purpose. It is a
 * structural capability of the data model rather than a premium add-on, and
 * crippling it on Starter would mean shipping a worse model to the customers
 * most likely to churn. Leg-based handover and multi-depot are the genuinely
 * advanced operations features, so those carry the tiering weight.
 */
export const PLANS: readonly PlanDefinition[] = [
  {
    key: "starter",
    name: "Starter",
    priceMonthly: 49,
    includedJobsPerMonth: 75,
    overagePricePerJob: 1.5,
    features: features(["poc_pod_capture", "multi_vehicle_consignments", "rate_cards"]),
  },
  {
    key: "growth",
    name: "Growth",
    priceMonthly: 99,
    includedJobsPerMonth: 200,
    overagePricePerJob: 1.0,
    features: features([
      "poc_pod_capture",
      "multi_vehicle_consignments",
      "rate_cards",
      "leg_handover",
      "live_gps_tracking",
      "automatic_invoicing",
      "analytics_dashboard",
    ]),
  },
  {
    key: "pro",
    name: "Pro",
    priceMonthly: 149,
    includedJobsPerMonth: null,
    overagePricePerJob: null,
    features: features([...PLAN_FEATURES]),
  },
] as const;

export const PLANS_BY_KEY: Record<string, PlanDefinition> = Object.fromEntries(
  PLANS.map((p) => [p.key, p]),
);

export class FeatureNotAvailableError extends Error {
  readonly feature: PlanFeature;
  readonly planKey: string;

  constructor(feature: PlanFeature, planKey: string) {
    super(`Feature "${feature}" is not available on the "${planKey}" plan.`);
    this.name = "FeatureNotAvailableError";
    this.feature = feature;
    this.planKey = planKey;
  }
}

export function planHasFeature(planKey: string, feature: PlanFeature): boolean {
  return PLANS_BY_KEY[planKey]?.features[feature] ?? false;
}

/**
 * Throws unless the plan grants the feature. Call this at the top of any
 * server action or route handler that performs a gated operation, before any
 * write. Never rely on the caller having hidden the UI.
 */
export function assertFeature(planKey: string, feature: PlanFeature): void {
  if (!planHasFeature(planKey, feature)) {
    throw new FeatureNotAvailableError(feature, planKey);
  }
}

/**
 * Whether a company that has used `used` consignments this period may start
 * another. Unmetered plans always may; metered plans may exceed the allowance
 * only when the plan defines an overage price.
 */
export function canStartConsignment(
  planKey: string,
  used: number,
): { allowed: boolean; overage: boolean; reason?: string } {
  const plan = PLANS_BY_KEY[planKey];
  if (!plan) return { allowed: false, overage: false, reason: "Unknown plan." };
  if (plan.includedJobsPerMonth === null) return { allowed: true, overage: false };
  if (used < plan.includedJobsPerMonth) return { allowed: true, overage: false };
  if (plan.overagePricePerJob === null) {
    return {
      allowed: false,
      overage: false,
      reason: `The ${plan.name} plan includes ${plan.includedJobsPerMonth} jobs per month and does not allow overage.`,
    };
  }
  return { allowed: true, overage: true };
}
