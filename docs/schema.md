# The data model

Four levels, from the client-facing order down to what a driver sees on their
phone:

```
consignment            what the client ordered, and what gets invoiced
  └── vehicle(s)       one or more cars moved under that order
        └── leg(s)     one driver, one custody segment, A to B
trip                   one driver's physical outing, grouping legs
```

A **leg** is the unit of custody: one driver in physical possession of one
vehicle between two points. Splitting a vehicle's journey into two legs is what
makes a mid-journey handover expressible. The legacy system could not do this.
It bolted a second driver onto the job with roughly sixty `ts_`-prefixed
columns and a parallel `ts_status` field, which meant every query, every index
and every report had to be written twice. One `legs` table with a `sequence`
collapses all of that.

A **trip** is the driver-facing view: one outing, several legs, possibly across
different vehicles and different consignments. A flatbed collecting three cars
from one compound and dropping them at three addresses is one trip, three
vehicles, six stops.

## Departures from the spec

Three, each deliberate and each easy to reverse if you disagree.

**`vehicles` is its own table.** The spec put registration and VIN inline on
`consignment_vehicles`, which is what the legacy system did: the same car moved
twice produced two unrelated records and there was no way to ask what has
happened to a given vehicle. Giving a vehicle identity costs one table now and
is expensive to retrofit later. The link is optional, so a one-off movement can
still carry its own registration without adding to a fleet list.

**`trip_stops` is a real table.** The spec described a trip's stops as derived
from its legs. Derived ordering cannot record a dispatcher's manual reordering,
and route order is exactly the thing a dispatcher wants to control.

**Depots are locations.** The spec left open whether handover points need their
own table. They do not. `locations.kind` includes `depot`, and a leg may
reference a saved location or carry a one-off address inline, so nobody is
forced to create a depot record just to type an address they will use once.

## Things carried over from the legacy build

**Banded rate cards.** Each band charges a flat fee plus a per-mile rate for the
portion of the distance falling inside it, so flat, per-mile and tapered
pricing are all special cases of one model. This ran at volume for years; it is
adopted rather than reinvented. The spec listed rate card complexity as an open
question, and this is the answer.

**The damage taxonomy.** `condition_findings` names a body section and a damage
type, with the vocabularies in
`packages/shared/src/reference/damage.ts`, carried over from the legacy
`damageSectionsMap` and `damageTypesMap`. Four van section labels that had been
copy-pasted from the car map are corrected.

**The appraisal checklist.** Held as `jsonb` on the custody event rather than
as sixty columns, because the checklist changes shape over time and an event
from two years ago must still render exactly as it was captured. Field
definitions are in `packages/shared/src/reference/appraisal.ts`.

## Things fixed on the way across

**Signatures are media objects, not inline base64.** The legacy build stored
signature data URIs directly in the document. On Postgres that would put tens
of kilobytes of base64 on every custody event row, which is read constantly.

**Storage keys are scoped to the vehicle, not the job.** The legacy convention
was `job-files/{jobId}/collection_ns_front.jpg`, so on a multi-vehicle job the
second car's photos overwrote the first car's. The new convention is
`{company_id}/consignments/{id}/vehicles/{id}/legs/{id}/{slug}.jpg`, which is
also prefixed with the tenant so a storage policy can be written against the
path.

**Capture time and sync time are separate, and there is an idempotency key.**
The legacy driver app had no offline queue at all, and its optimistic reducer
advanced the UI whether or not the write landed, so a photo taken in a compound
with no signal was simply lost. `custody_events` carries `captured_at`,
`synced_at`, `offline_captured` and `idempotency_key` from day one, even though
the sync client itself is a later phase. `captured_at` is the one a dispute
turns on.

**Reference numbers are per tenant.** The legacy build had a single global
counter in `_stats/jobs`. Two tenants must not be able to infer each other's
volume from their own job numbers, so `company_counters` holds a sequence per
company, advanced by a definer trigger that takes a row lock. Concurrent
bookings at one company serialise; other tenants are unaffected.

## Evidence is append-only

`custody_events`, `media_objects`, `audit_log` and `leg_location_points` have
no delete policy for anyone, including company owners. `audit_log` has no
update policy either. A photograph that disproves a damage claim must not be
removable by the party the claim is against, and an audit trail the audited
party can edit is decoration. The schema guard test asserts all of this.

Staff cannot edit a custody event at all. Only the driver who captured it can,
and only their own. That is so a late photo upload can attach itself to an
event already created, not so the record can be revised after an argument
starts.

## Status is not duplicated

Statuses live in Postgres enums, listed in `packages/shared/src/enums.ts` and
checked against `pg_enum` by the parity test. Two legacy oddities are not
carried over: status `90` (On Hold) was never persisted and was synthesised on
read from a `hold` boolean, and status `52` (Delivered) existed in the enum but
nothing ever wrote it.

## Where the rules actually live

| Concern | Where |
|---|---|
| Schema, policies, triggers, constraints | `packages/db/migrations/*.sql` (source of truth) |
| Typed query surface | `packages/db/src/schema/` (mirrors the SQL; parity tested) |
| Enums, plan features, validation, vocabularies | `packages/shared/src/` |
| Proof that it fails closed | `packages/db/test/` |
