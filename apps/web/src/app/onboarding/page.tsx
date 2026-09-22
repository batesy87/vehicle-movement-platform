import { redirect } from "next/navigation";
import { PLANS } from "@platform/shared";
import { getSession } from "@/lib/session";
import { OnboardingForm } from "./form";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Somebody who already has a company reached this by hand.
  if (session.activeCompany) redirect("/dashboard");

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <OnboardingForm plans={PLANS.map((p) => ({ ...p, features: { ...p.features } }))} />
    </main>
  );
}
