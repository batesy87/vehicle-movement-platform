/**
 * Postgres enums, mirrored for the query builder.
 *
 * The SQL migrations are the source of truth. These declarations exist so
 * TypeScript knows the shapes; the enum parity test compares them against
 * pg_enum and fails if the two drift.
 */

import { pgEnum } from "drizzle-orm/pg-core";
import {
  AUDIT_ACTIONS,
  BILLING_MODELS,
  BILLING_STATUSES,
  COMPANY_ROLES,
  COMPANY_STATUSES,
  CONSIGNMENT_STATUSES,
  CONSIGNMENT_VEHICLE_STATUSES,
  CUSTODY_EVENT_TYPES,
  DRIVER_LINK_STATUSES,
  DRIVER_TYPES,
  INVITATION_KINDS,
  INVITATION_STATUSES,
  INVOICE_STATUSES,
  LEG_STATUSES,
  LOCATION_KINDS,
  MEDIA_KINDS,
  PICKUP_MODES,
  RATE_BASES,
  STOP_KINDS,
  TRIP_STATUSES,
  VEHICLE_CAPABILITIES,
} from "@platform/shared";

// drizzle's pgEnum wants a mutable non-empty tuple; the shared constants are
// readonly arrays. The double assertion is the narrowest way to say "this has
// at least one element" without restating every list.
const mut = <T extends readonly string[]>(v: T) =>
  [...v] as unknown as [string, ...string[]];

export const companyStatus = pgEnum("company_status", mut(COMPANY_STATUSES));
export const billingModel = pgEnum("billing_model", mut(BILLING_MODELS));
export const companyRole = pgEnum("company_role", mut(COMPANY_ROLES));
export const driverLinkStatus = pgEnum("driver_link_status", mut(DRIVER_LINK_STATUSES));
export const driverType = pgEnum("driver_type", mut(DRIVER_TYPES));
export const vehicleCapability = pgEnum("vehicle_capability", mut(VEHICLE_CAPABILITIES));
export const invitationKind = pgEnum("invitation_kind", mut(INVITATION_KINDS));
export const invitationStatus = pgEnum("invitation_status", mut(INVITATION_STATUSES));
export const consignmentStatus = pgEnum("consignment_status", mut(CONSIGNMENT_STATUSES));
export const pickupMode = pgEnum("pickup_mode", mut(PICKUP_MODES));
export const billingStatus = pgEnum("billing_status", mut(BILLING_STATUSES));
export const consignmentVehicleStatus = pgEnum(
  "consignment_vehicle_status",
  mut(CONSIGNMENT_VEHICLE_STATUSES),
);
export const legStatus = pgEnum("leg_status", mut(LEG_STATUSES));
export const tripStatus = pgEnum("trip_status", mut(TRIP_STATUSES));
export const stopKind = pgEnum("stop_kind", mut(STOP_KINDS));
export const custodyEventType = pgEnum("custody_event_type", mut(CUSTODY_EVENT_TYPES));
export const locationKind = pgEnum("location_kind", mut(LOCATION_KINDS));
export const rateBasis = pgEnum("rate_basis", mut(RATE_BASES));
export const invoiceStatus = pgEnum("invoice_status", mut(INVOICE_STATUSES));
export const mediaKind = pgEnum("media_kind", mut(MEDIA_KINDS));
export const auditAction = pgEnum("audit_action", mut(AUDIT_ACTIONS));
