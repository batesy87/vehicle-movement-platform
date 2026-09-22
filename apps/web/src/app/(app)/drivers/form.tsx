"use client";

import { useActionState } from "react";
import { DRIVER_TYPES, VEHICLE_CAPABILITIES } from "@platform/shared";
import { inviteDriver, type InviteDriverState } from "./actions";
import { Button, Card, FormError, Input, Label, Notice, Select } from "@/components/ui";

const initial: InviteDriverState = {};

const CAPABILITY_LABELS: Record<string, string> = {
  car: "Car (driven)",
  flatbed: "Flatbed",
  hgv_trailer: "HGV with trailer",
};

export function InviteDriverForm() {
  const [state, formAction, pending] = useActionState(inviteDriver, initial);

  return (
    <Card>
      <h2 className="font-medium">Invite a driver</h2>
      <p className="mt-1 mb-4 text-sm text-ink-500 dark:text-ink-300">
        If they already drive for another company on the platform, they will be asked to confirm
        before their details are shared with you.
      </p>

      <form action={formAction} className="space-y-4">
        <FormError message={state.error} />
        {state.message ? <Notice>{state.message}</Notice> : null}
        {state.inviteLink ? (
          <Notice>
            Email delivery is not wired up yet, so here is the link:{" "}
            <code className="break-all text-xs">{state.inviteLink}</code>
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="Optional if they already have a profile" />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="phone">Phone</Label>
            <Input id="phone" name="phone" placeholder="Optional" />
          </div>
          <div>
            <Label htmlFor="driverType">Engagement</Label>
            <Select id="driverType" name="driverType" defaultValue="self_employed">
              {DRIVER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "self_employed" ? "Self-employed" : "Employed"}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="vehicleCapability">Can drive</Label>
            <Select id="vehicleCapability" name="vehicleCapability" defaultValue="car">
              {VEHICLE_CAPABILITIES.map((capability) => (
                <option key={capability} value={capability}>
                  {CAPABILITY_LABELS[capability] ?? capability}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? "Sending..." : "Send invitation"}
        </Button>
      </form>
    </Card>
  );
}
