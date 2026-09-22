/**
 * Drizzle table definitions.
 *
 * The SQL in migrations/ is the source of truth for the schema: it holds the
 * policies, the composite foreign keys, the triggers and the check
 * constraints, none of which have a faithful representation here. These
 * declarations exist purely so application queries are typed.
 *
 * Drift between the two is caught by test/schema-parity.test.ts, which
 * compares every table and column declared here against information_schema.
 *
 * Nothing here turns off row level security. Queries built from these tables
 * still run inside withTenantSession and are still subject to every policy.
 */

import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import * as e from "./enums";

const id = () => uuid("id").primaryKey().defaultRandom();
const companyId = () => uuid("company_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// --- global, not tenant-scoped --------------------------------------------

export const plans = pgTable("plans", {
  id: id(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  priceMonthly: numeric("price_monthly", { precision: 12, scale: 2 }).notNull(),
  includedJobsPerMonth: integer("included_jobs_per_month"),
  overagePricePerJob: numeric("overage_price_per_job", { precision: 12, scale: 2 }),
  features: jsonb("features").notNull().default({}),
  isPublic: boolean("is_public").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const driverProfiles = pgTable("driver_profiles", {
  id: id(),
  authUserId: uuid("auth_user_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  licenceNumber: text("licence_number"),
  licenceCategories: text("licence_categories").array().notNull().default([]),
  vehicleCapability: e.vehicleCapability("vehicle_capability").notNull().default("car"),
  isConfirmed: boolean("is_confirmed").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- tenant root and membership -------------------------------------------

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  tradingName: text("trading_name"),
  registrationNumber: text("registration_number"),
  billingModel: e.billingModel("billing_model").notNull().default("subscription"),
  planId: uuid("plan_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: e.companyStatus("status").notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companyUsers = pgTable("company_users", {
  id: id(),
  companyId: companyId(),
  userId: uuid("user_id").notNull(),
  role: e.companyRole("role").notNull().default("dispatcher"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const driverCompanyLinks = pgTable("driver_company_links", {
  id: id(),
  driverProfileId: uuid("driver_profile_id").notNull(),
  companyId: companyId(),
  driverType: e.driverType("driver_type").notNull().default("self_employed"),
  status: e.driverLinkStatus("status").notNull().default("invited"),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  payRate: numeric("pay_rate", { precision: 12, scale: 2 }),
  terms: text("terms"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invitations = pgTable("invitations", {
  id: id(),
  companyId: companyId(),
  kind: e.invitationKind("kind").notNull(),
  email: text("email").notNull(),
  role: e.companyRole("role"),
  driverProfileId: uuid("driver_profile_id"),
  tokenHash: text("token_hash").notNull(),
  status: e.invitationStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  invitedBy: uuid("invited_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companyCounters = pgTable("company_counters", {
  companyId: uuid("company_id").primaryKey(),
  consignmentNextNo: integer("consignment_next_no").notNull().default(1),
  invoiceNextNo: integer("invoice_next_no").notNull().default(1),
});

// --- operational reference -------------------------------------------------

export const clients = pgTable("clients", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  billingAddress: jsonb("billing_address"),
  defaultRateCardId: uuid("default_rate_card_id"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locations = pgTable("locations", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  kind: e.locationKind("kind").notNull().default("other"),
  address: jsonb("address").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vehicles = pgTable("vehicles", {
  id: id(),
  companyId: companyId(),
  registration: text("registration"),
  vin: text("vin"),
  make: text("make"),
  model: text("model"),
  colour: text("colour"),
  bodyType: text("body_type").notNull().default("car"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rateCards = pgTable("rate_cards", {
  id: id(),
  companyId: companyId(),
  name: text("name").notNull(),
  basis: e.rateBasis("basis").notNull().default("banded"),
  flatAmount: numeric("flat_amount", { precision: 12, scale: 2 }),
  perMileAmount: numeric("per_mile_amount", { precision: 12, scale: 4 }),
  perVehicleAmount: numeric("per_vehicle_amount", { precision: 12, scale: 2 }),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rateCardBands = pgTable("rate_card_bands", {
  id: id(),
  rateCardId: uuid("rate_card_id").notNull(),
  companyId: companyId(),
  rangeFrom: integer("range_from").notNull(),
  rangeTo: integer("range_to").notNull(),
  valueFlat: numeric("value_flat", { precision: 12, scale: 2 }).notNull().default("0"),
  valuePer: numeric("value_per", { precision: 12, scale: 4 }).notNull().default("0"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- movement engine -------------------------------------------------------

export const consignments = pgTable("consignments", {
  id: id(),
  companyId: companyId(),
  clientId: uuid("client_id").notNull(),
  referenceNo: integer("reference_no"),
  clientReference: text("client_reference"),
  status: e.consignmentStatus("status").notNull().default("draft"),
  pickupMode: e.pickupMode("pickup_mode").notNull().default("single"),
  pickupLocationId: uuid("pickup_location_id"),
  dropoffLocationId: uuid("dropoff_location_id"),
  pickupAddress: jsonb("pickup_address"),
  dropoffAddress: jsonb("dropoff_address"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  rateCardId: uuid("rate_card_id"),
  billingAmount: numeric("billing_amount", { precision: 12, scale: 2 }),
  billingStatus: e.billingStatus("billing_status").notNull().default("pending"),
  notes: text("notes"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const consignmentVehicles = pgTable("consignment_vehicles", {
  id: id(),
  companyId: companyId(),
  consignmentId: uuid("consignment_id").notNull(),
  vehicleId: uuid("vehicle_id"),
  sequence: integer("sequence").notNull().default(1),
  registration: text("registration"),
  vin: text("vin"),
  make: text("make"),
  model: text("model"),
  colour: text("colour"),
  bodyType: text("body_type").notNull().default("car"),
  pickupLocationId: uuid("pickup_location_id"),
  dropoffLocationId: uuid("dropoff_location_id"),
  pickupAddress: jsonb("pickup_address"),
  dropoffAddress: jsonb("dropoff_address"),
  currentStatus: e
    .consignmentVehicleStatus("current_status")
    .notNull()
    .default("awaiting_collection"),
  currentCustodyDriverId: uuid("current_custody_driver_id"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const trips = pgTable("trips", {
  id: id(),
  companyId: companyId(),
  driverProfileId: uuid("driver_profile_id").notNull(),
  tripDate: date("trip_date").notNull(),
  status: e.tripStatus("status").notNull().default("planned"),
  transportUsed: text("transport_used"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const legs = pgTable("legs", {
  id: id(),
  companyId: companyId(),
  consignmentVehicleId: uuid("consignment_vehicle_id").notNull(),
  sequence: integer("sequence").notNull(),
  driverProfileId: uuid("driver_profile_id"),
  tripId: uuid("trip_id"),
  fromLocationId: uuid("from_location_id"),
  toLocationId: uuid("to_location_id"),
  fromAddress: jsonb("from_address"),
  toAddress: jsonb("to_address"),
  plannedStart: timestamp("planned_start", { withTimezone: true }),
  plannedEnd: timestamp("planned_end", { withTimezone: true }),
  status: e.legStatus("status").notNull().default("unassigned"),
  distanceMiles: numeric("distance_miles", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tripStops = pgTable("trip_stops", {
  id: id(),
  companyId: companyId(),
  tripId: uuid("trip_id").notNull(),
  legId: uuid("leg_id").notNull(),
  kind: e.stopKind("kind").notNull(),
  sequence: integer("sequence").notNull(),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --- custody evidence ------------------------------------------------------

export const mediaObjects = pgTable("media_objects", {
  id: id(),
  companyId: companyId(),
  kind: e.mediaKind("kind").notNull().default("photo"),
  bucket: text("bucket").notNull().default("custody-media"),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }),
  checksumSha256: text("checksum_sha256"),
  width: integer("width"),
  height: integer("height"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  uploadedBy: uuid("uploaded_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const custodyEvents = pgTable("custody_events", {
  id: id(),
  companyId: companyId(),
  legId: uuid("leg_id").notNull(),
  eventType: e.custodyEventType("event_type").notNull(),
  pairedEventId: uuid("paired_event_id"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  offlineCaptured: boolean("offline_captured").notNull().default(false),
  gpsLatitude: numeric("gps_latitude", { precision: 9, scale: 6 }),
  gpsLongitude: numeric("gps_longitude", { precision: 9, scale: 6 }),
  gpsAccuracyM: numeric("gps_accuracy_m", { precision: 8, scale: 2 }),
  odometer: integer("odometer"),
  fuelLevel: text("fuel_level"),
  chargeLevel: text("charge_level"),
  preSurvey: jsonb("pre_survey"),
  appraisal: jsonb("appraisal"),
  signOff: jsonb("sign_off"),
  handover: jsonb("handover"),
  conditionNotes: text("condition_notes"),
  driverName: text("driver_name"),
  driverSignatureId: uuid("driver_signature_id"),
  counterpartyName: text("counterparty_name"),
  counterpartySignatureId: uuid("counterparty_signature_id"),
  capturedByDriverId: uuid("captured_by_driver_id").notNull(),
  idempotencyKey: text("idempotency_key"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conditionFindings = pgTable("condition_findings", {
  id: id(),
  companyId: companyId(),
  custodyEventId: uuid("custody_event_id").notNull(),
  scope: text("scope").notNull().default("exterior"),
  bodyType: text("body_type"),
  sectionKey: text("section_key"),
  damageTypeKey: text("damage_type_key"),
  description: text("description"),
  note: text("note"),
  mediaId: uuid("media_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const legLocationPoints = pgTable("leg_location_points", {
  id: id(),
  companyId: companyId(),
  legId: uuid("leg_id").notNull(),
  driverProfileId: uuid("driver_profile_id").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
  accuracyM: numeric("accuracy_m", { precision: 8, scale: 2 }),
  speedMps: numeric("speed_mps", { precision: 8, scale: 2 }),
  headingDeg: numeric("heading_deg", { precision: 6, scale: 2 }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// --- billing, metering and audit -------------------------------------------

export const invoices = pgTable("invoices", {
  id: id(),
  companyId: companyId(),
  clientId: uuid("client_id").notNull(),
  invoiceNo: integer("invoice_no").notNull(),
  status: e.invoiceStatus("status").notNull().default("draft"),
  issuedOn: date("issued_on"),
  dueOn: date("due_on"),
  currency: char("currency", { length: 3 }).notNull().default("GBP"),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  externalRef: text("external_ref"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  companyId: companyId(),
  invoiceId: uuid("invoice_id").notNull(),
  consignmentId: uuid("consignment_id"),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
  unitAmount: numeric("unit_amount", { precision: 12, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 6, scale: 4 }).notNull().default("0"),
  lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
  sequence: integer("sequence").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const usageCounters = pgTable("usage_counters", {
  id: id(),
  companyId: companyId(),
  periodStart: date("period_start").notNull(),
  consignmentsStarted: integer("consignments_started").notNull().default(0),
  consignmentsCompleted: integer("consignments_completed").notNull().default(0),
  overageUnits: integer("overage_units").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: companyId(),
  tableName: text("table_name").notNull(),
  recordId: uuid("record_id").notNull(),
  action: e.auditAction("action").notNull(),
  changes: jsonb("changes"),
  actorUserId: uuid("actor_user_id"),
  actorDriverProfileId: uuid("actor_driver_profile_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
