"use client";

import { useActionState, useState } from "react";
import type { PlanDefinition } from "@platform/shared";
import { createCompany, type OnboardingState } from "./actions";
import { Button, Card, FormError, Input, Label, PageHeader } from "@/components/ui";

const initial: OnboardingState = {};

const FEATURE_LABELS: Record<string, string> = {
  poc_pod_capture: "Proof of collection and delivery",
  multi_vehicle_consignments: "Multi-vehicle consignments",
  leg_handover: "Leg-based handover",
  live_gps_tracking: "Live GPS tracking",
  automatic_invoicing: "Automatic invoicing",
  rate_cards: "Rate cards",
  analytics_dashboard: "Analytics dashboard",
  multi_depot: "Multi-depot and handover points",
  api_access: "API access",
  white_labelling: "White labelling",
};

export function OnboardingForm({ plans }: { plans: PlanDefinition[] }) {
  const [state, formAction, pending] = useActionState(createCompany, initial);
  const [selected, setSelected] = useState(plans[1]?.key ?? plans[0]!.key);

  return (
    <>
      <PageHeader
        title="Set up your company"
        description="This takes a minute and starts your trial. You can change plan later."
      />

      <form action={formAction} className="space-y-6">
        <FormError message={state.error} />

        <Card>
          <div className="space-y-4">
            <div>
              <Label htmlFor="name">Company name</Label>
              <Input id="name" name="name" required autoFocus />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tradingName">Trading name</Label>
                <Input id="tradingName" name="tradingName" placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="registrationNumber">Company number</Label>
                <Input id="registrationNumber" name="registrationNumber" placeholder="Optional" />
              </div>
            </div>
          </div>
        </Card>

        <fieldset>
          <legend className="mb-3 text-sm font-medium">Choose a plan</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {plans.map((plan) => {
              const isSelected = selected === plan.key;
              return (
                <label
                  key={plan.key}
                  className={`cursor-pointer rounded-xl border p-4 transition ${
                    isSelected
                      ? "border-accent-500 ring-2 ring-accent-500/25"
                      : "border-ink-200 hover:border-ink-300 dark:border-ink-700"
                  } bg-white dark:bg-ink-800`}
                >
                  <input
                    type="radio"
                    name="planKey"
                    value={plan.key}
                    checked={isSelected}
                    onChange={() => setSelected(plan.key)}
                    className="sr-only"
                  />
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{plan.name}</span>
                    <span className="text-sm">£{plan.priceMonthly}/mo</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
                    {plan.includedJobsPerMonth === null
                      ? "Unlimited jobs"
                      : `${plan.includedJobsPerMonth} jobs per month`}
                  </p>
                  <ul className="mt-3 space-y-1 text-xs">
                    {Object.entries(plan.features)
                      .filter(([, enabled]) => enabled)
                      .map(([feature]) => (
                        <li key={feature} className="text-ink-600 dark:text-ink-300">
                          {FEATURE_LABELS[feature] ?? feature}
                        </li>
                      ))}
                  </ul>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create company and start trial"}
        </Button>
      </form>
    </>
  );
}
