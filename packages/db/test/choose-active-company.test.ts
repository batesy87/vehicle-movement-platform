/**
 * The rule the application follows so it does not undo the one the database
 * enforces.
 *
 * Pure, so it needs no database. It is here rather than in the web app because
 * this is where `Membership` lives and where the suite that CI runs already is.
 */

import { describe, expect, it } from "vitest";
import { chooseActiveCompany, type Membership } from "../src/index";

function membership(companyId: string, companyName: string): Membership {
  return {
    companyId,
    companyName,
    planKey: "pro",
    status: "active",
    staffRole: "owner",
    isDriver: false,
  };
}

// Deliberately in the order my_memberships() would return them, which is by
// company name. The bug this guards against was "take the first one".
const acme = membership("11111111-1111-1111-1111-111111111111", "Acme Logistics");
const zenith = membership("22222222-2222-2222-2222-222222222222", "Zenith Transport");

describe("with one membership", () => {
  it("defaults to it, because that is not a choice", () => {
    expect(chooseActiveCompany([acme], null)?.companyId).toBe(acme.companyId);
  });

  it("still defaults when the request names something unrecognised", () => {
    expect(chooseActiveCompany([acme], "gone")?.companyId).toBe(acme.companyId);
  });
});

describe("with several memberships", () => {
  it("honours a valid request", () => {
    expect(chooseActiveCompany([acme, zenith], zenith.companyId)?.companyId).toBe(zenith.companyId);
  });

  it("returns null when nothing has been chosen", () => {
    // The whole point. Returning acme here because it sorts first is how an
    // invitation ends up in the wrong company.
    expect(chooseActiveCompany([acme, zenith], null)).toBeNull();
  });

  it("returns null rather than defaulting when the request is stale", () => {
    // A cookie pointing at a company the user has been removed from. Asking
    // again is correct; silently moving them to a different tenant is not.
    expect(chooseActiveCompany([acme, zenith], "33333333-3333-3333-3333-333333333333")).toBeNull();
  });

  it("does not quietly prefer the alphabetically first company", () => {
    expect(chooseActiveCompany([acme, zenith], undefined)).not.toBe(acme);
  });
});

describe("with no memberships", () => {
  it("returns null, which the caller reads as onboarding", () => {
    expect(chooseActiveCompany([], null)).toBeNull();
    expect(chooseActiveCompany([], "anything")).toBeNull();
  });
});
