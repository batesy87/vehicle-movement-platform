/**
 * Input validation shared by the web app, the future driver app and any API
 * surface. Server actions validate with these before touching the database;
 * row-level security is the backstop, not the first line.
 */

import { z } from "zod";
import {
  BILLING_MODELS,
  COMPANY_ROLES,
  DRIVER_TYPES,
  LOCATION_KINDS,
  VEHICLE_CAPABILITIES,
} from "./enums";

export const uuidSchema = z.string().uuid();

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email("Enter a valid email address")
  .transform((v) => v.toLowerCase());

/**
 * UK mobile and landline numbers, loosely. Deliberately permissive: refusing a
 * driver's real number because of a formatting rule is worse than storing a
 * number with an odd shape.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(7, "Enter a valid phone number")
  .max(32)
  .regex(/^[+0-9 ()-]+$/, "Phone numbers may only contain digits, spaces and + ( ) -");

/**
 * UK vehicle registration marks. Normalised to uppercase without spaces, which
 * is how they are stored and matched. The legacy build uppercased but kept
 * spaces, so "AB12 CDE" and "AB12CDE" were different vehicles.
 */
export const registrationSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
  .refine((v) => /^[A-Z0-9]+$/.test(v), "Registration may only contain letters and numbers");

/** ISO 3779 VIN. 17 characters, excluding I, O and Q. */
export const vinSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
  .refine((v) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v), "Enter a valid 17-character VIN");

export const postcodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/\s+/g, " "))
  .refine(
    (v) => /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/.test(v),
    "Enter a valid UK postcode",
  );

export const addressSchema = z.object({
  line1: z.string().trim().min(1, "Address line 1 is required").max(200),
  line2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().min(1, "City is required").max(120),
  county: z.string().trim().max(120).optional().or(z.literal("")),
  postcode: postcodeSchema,
  country: z.string().trim().max(60).default("United Kingdom"),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export type AddressInput = z.infer<typeof addressSchema>;

// --- Signup and onboarding -------------------------------------------------

export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), "Include upper and lower case letters")
  .refine((v) => /\d/.test(v), "Include at least one number");

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your name").max(120),
  email: emailSchema,
  password: passwordSchema,
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password"),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const createCompanySchema = z.object({
  name: z.string().trim().min(2, "Enter your company name").max(200),
  tradingName: z.string().trim().max(200).optional().or(z.literal("")),
  registrationNumber: z.string().trim().max(40).optional().or(z.literal("")),
  planKey: z.string().trim().min(1, "Choose a plan"),
  billingModel: z.enum(BILLING_MODELS).default("subscription"),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

// --- Invitations -----------------------------------------------------------

export const inviteCompanyUserSchema = z.object({
  email: emailSchema,
  role: z.enum(COMPANY_ROLES).refine((r) => r !== "owner", {
    message: "Ownership is transferred, not invited",
  }),
});

export type InviteCompanyUserInput = z.infer<typeof inviteCompanyUserSchema>;

export const inviteDriverSchema = z.object({
  email: emailSchema,
  /** Optional when the driver already has a profile: theirs wins. */
  name: z.string().trim().min(2).max(120).optional().or(z.literal("")),
  phone: phoneSchema.optional().or(z.literal("")),
  driverType: z.enum(DRIVER_TYPES).default("self_employed"),
  vehicleCapability: z.enum(VEHICLE_CAPABILITIES).default("car"),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export type InviteDriverInput = z.infer<typeof inviteDriverSchema>;

// --- Operational reference -------------------------------------------------

export const clientSchema = z.object({
  name: z.string().trim().min(2, "Client name is required").max(200),
  contactName: z.string().trim().max(120).optional().or(z.literal("")),
  email: emailSchema.optional().or(z.literal("")),
  phone: phoneSchema.optional().or(z.literal("")),
  billingAddress: addressSchema.optional(),
  defaultRateCardId: uuidSchema.optional(),
});

export type ClientInput = z.infer<typeof clientSchema>;

export const locationSchema = z.object({
  name: z.string().trim().min(1, "Give this location a name").max(200),
  kind: z.enum(LOCATION_KINDS).default("other"),
  address: addressSchema,
  contactName: z.string().trim().max(120).optional().or(z.literal("")),
  contactPhone: phoneSchema.optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export type LocationInput = z.infer<typeof locationSchema>;

/**
 * A rate card band, carried over from the legacy banded pricing engine. Each
 * band charges a flat fee plus a per-mile rate for the portion of the journey
 * that falls inside it, so "first 50 miles at 1.20 plus 15.00, thereafter
 * 0.95" is expressible without special cases.
 */
export const rateBandSchema = z
  .object({
    rangeFrom: z.number().int().min(0),
    rangeTo: z.number().int().min(1),
    valueFlat: z.number().min(0),
    valuePer: z.number().min(0),
  })
  .refine((b) => b.rangeTo > b.rangeFrom, {
    message: "A band must end after it starts",
    path: ["rangeTo"],
  });

export const rateCardSchema = z
  .object({
    name: z.string().trim().min(1, "Name this rate card").max(200),
    basis: z.enum(["flat", "per_mile", "per_vehicle", "banded"]),
    flatAmount: z.number().min(0).optional(),
    perMileAmount: z.number().min(0).optional(),
    perVehicleAmount: z.number().min(0).optional(),
    bands: z.array(rateBandSchema).default([]),
  })
  .superRefine((card, ctx) => {
    if (card.basis === "banded" && card.bands.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bands"],
        message: "A banded rate card needs at least one band",
      });
    }
    if (card.basis === "flat" && card.flatAmount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["flatAmount"], message: "Enter the flat rate" });
    }
    if (card.basis === "per_mile" && card.perMileAmount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["perMileAmount"], message: "Enter the per-mile rate" });
    }
    if (card.basis === "per_vehicle" && card.perVehicleAmount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["perVehicleAmount"], message: "Enter the per-vehicle rate" });
    }
    // Bands must tile the range without gaps or overlaps, otherwise a journey
    // of a given length has an ambiguous price.
    const sorted = [...card.bands].sort((a, b) => a.rangeFrom - b.rangeFrom);
    for (let i = 0; i < sorted.length; i++) {
      const band = sorted[i]!;
      const previous = i > 0 ? sorted[i - 1] : undefined;
      if (previous && band.rangeFrom !== previous.rangeTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bands", i, "rangeFrom"],
          message: `Band must start at ${previous.rangeTo} to follow on from the previous band`,
        });
      }
    }
  });

export type RateCardInput = z.infer<typeof rateCardSchema>;
