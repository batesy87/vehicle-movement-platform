/**
 * Domain enumerations.
 *
 * Every value here has a matching Postgres enum in packages/db/migrations.
 * The `assertEnumParity` test in packages/db walks both and fails if they
 * drift, so this file and the database can never disagree silently.
 */

export const COMPANY_STATUSES = ["trial", "active", "past_due", "cancelled"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const BILLING_MODELS = ["subscription", "payg", "hybrid"] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

/** Roles a human staff member can hold inside one company. */
export const COMPANY_ROLES = ["owner", "admin", "dispatcher", "viewer"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

/**
 * Rank used for "at least this role" checks. Higher is more privileged.
 * Drivers are deliberately absent: a driver is not a member of company staff,
 * they are linked through driver_company_links instead.
 */
export const COMPANY_ROLE_RANK: Record<CompanyRole, number> = {
  viewer: 10,
  dispatcher: 20,
  admin: 30,
  owner: 40,
};

export const DRIVER_LINK_STATUSES = ["invited", "active", "inactive", "declined"] as const;
export type DriverLinkStatus = (typeof DRIVER_LINK_STATUSES)[number];

export const DRIVER_TYPES = ["employed", "self_employed"] as const;
export type DriverType = (typeof DRIVER_TYPES)[number];

/**
 * What a driver is licensed and equipped to move. Determines which legs they
 * can be offered (spec 4.1 step 5): never offer a car-only driver an
 * hgv_trailer leg.
 */
export const VEHICLE_CAPABILITIES = ["car", "flatbed", "hgv_trailer"] as const;
export type VehicleCapability = (typeof VEHICLE_CAPABILITIES)[number];

/** Capability ordering: a driver with a higher capability can run lower legs. */
export const VEHICLE_CAPABILITY_RANK: Record<VehicleCapability, number> = {
  car: 10,
  flatbed: 20,
  hgv_trailer: 30,
};

export const INVITATION_KINDS = ["company_user", "driver_new", "driver_link"] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];

export const INVITATION_STATUSES = ["pending", "accepted", "declined", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const CONSIGNMENT_STATUSES = [
  "draft",
  "scheduled",
  "in_progress",
  "completed",
  "invoiced",
  "cancelled",
] as const;
export type ConsignmentStatus = (typeof CONSIGNMENT_STATUSES)[number];

/**
 * Whether every vehicle on a consignment shares one pickup and dropoff, or
 * each vehicle routes independently (spec 2.5).
 */
export const PICKUP_MODES = ["single", "multi"] as const;
export type PickupMode = (typeof PICKUP_MODES)[number];

export const BILLING_STATUSES = ["pending", "invoiced", "paid", "disputed"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const CONSIGNMENT_VEHICLE_STATUSES = [
  "awaiting_collection",
  "in_transit",
  "at_handover",
  "delivered",
  "cancelled",
] as const;
export type ConsignmentVehicleStatus = (typeof CONSIGNMENT_VEHICLE_STATUSES)[number];

export const LEG_STATUSES = [
  "unassigned",
  "assigned",
  "collected",
  "in_transit",
  "delivered",
  "handed_over",
  "cancelled",
] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

export const TRIP_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** A trip stop is one end of one leg: either picking a vehicle up or dropping it off. */
export const STOP_KINDS = ["collection", "delivery"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** Custody events use the same two kinds; one leg produces exactly one of each. */
export const CUSTODY_EVENT_TYPES = ["collection", "delivery"] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export const LOCATION_KINDS = ["pickup", "dropoff", "depot", "other"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const RATE_BASES = ["flat", "per_mile", "per_vehicle", "banded"] as const;
export type RateBasis = (typeof RATE_BASES)[number];

export const INVOICE_STATUSES = ["draft", "issued", "paid", "void", "disputed"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const MEDIA_KINDS = ["photo", "signature", "document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Every Postgres enum in the schema, keyed by its type name. The database
 * parity test iterates this, so adding an enum above without registering it
 * here is caught by CI.
 */
export const PG_ENUMS = {
  company_status: COMPANY_STATUSES,
  billing_model: BILLING_MODELS,
  company_role: COMPANY_ROLES,
  driver_link_status: DRIVER_LINK_STATUSES,
  driver_type: DRIVER_TYPES,
  vehicle_capability: VEHICLE_CAPABILITIES,
  invitation_kind: INVITATION_KINDS,
  invitation_status: INVITATION_STATUSES,
  consignment_status: CONSIGNMENT_STATUSES,
  pickup_mode: PICKUP_MODES,
  billing_status: BILLING_STATUSES,
  consignment_vehicle_status: CONSIGNMENT_VEHICLE_STATUSES,
  leg_status: LEG_STATUSES,
  trip_status: TRIP_STATUSES,
  stop_kind: STOP_KINDS,
  custody_event_type: CUSTODY_EVENT_TYPES,
  location_kind: LOCATION_KINDS,
  rate_basis: RATE_BASES,
  invoice_status: INVOICE_STATUSES,
  media_kind: MEDIA_KINDS,
  audit_action: AUDIT_ACTIONS,
} as const satisfies Record<string, readonly string[]>;

export type PgEnumName = keyof typeof PG_ENUMS;
