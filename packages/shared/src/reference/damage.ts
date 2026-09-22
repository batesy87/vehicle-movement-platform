/**
 * Vehicle condition taxonomy, carried over from the legacy YVM build
 * (`src/types/job.ts` `damageSectionsMap` / `damageTypesMap`).
 *
 * This vocabulary took real operational iteration to settle and it drives the
 * `condition_findings` table: a finding names a body section and a damage
 * type, and only combinations whose surface kinds intersect are valid. Keeping
 * it as data rather than hardcoding it in the capture UI means the web app,
 * the driver app and the PDF renderer all agree.
 *
 * Two deliberate corrections against the legacy source: the van map had four
 * section labels copy-pasted from the car map ("Offside Rear Door" on
 * `offside_side_panel`, "Offside Rear Quarter" on `offside_rear_panel`, and
 * the nearside equivalents), which are fixed here to describe the panel they
 * actually name.
 */

/** The surface kind of a body section, used to filter applicable damage types. */
export const SURFACE_KINDS = ["panel", "trim", "glass", "wheel"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface BodySection {
  key: string;
  label: string;
  surfaces: readonly SurfaceKind[];
}

export interface DamageTypeDefinition {
  key: string;
  label: string;
  /** Surfaces this damage can occur on. */
  surfaces: readonly SurfaceKind[];
  /** Whether the capture flow should require a free-text note. */
  requiresNote?: boolean;
}

export const BODY_SECTIONS = {
  car: [
    { key: "front", label: "Front Area", surfaces: ["panel", "trim"] },
    { key: "bonnet", label: "Bonnet", surfaces: ["panel", "trim"] },
    { key: "windscreen", label: "Windscreen", surfaces: ["glass"] },
    { key: "offside_front_wheel", label: "Offside Front Wheel", surfaces: ["wheel"] },
    { key: "offside_front_quarter", label: "Offside Front Quarter", surfaces: ["panel", "trim"] },
    { key: "offside_front_door", label: "Offside Front Door", surfaces: ["panel", "trim", "glass"] },
    { key: "offside_rear_door", label: "Offside Rear Door", surfaces: ["panel", "trim", "glass"] },
    { key: "offside_rear_quarter", label: "Offside Rear Quarter", surfaces: ["panel", "trim"] },
    { key: "offside_rear_wheel", label: "Offside Rear Wheel", surfaces: ["wheel"] },
    { key: "rear", label: "Rear Area", surfaces: ["panel", "trim"] },
    { key: "boot", label: "Boot Lid", surfaces: ["panel", "trim"] },
    { key: "rear_screen", label: "Rear Screen", surfaces: ["glass"] },
    { key: "nearside_rear_wheel", label: "Nearside Rear Wheel", surfaces: ["wheel"] },
    { key: "nearside_rear_quarter", label: "Nearside Rear Quarter", surfaces: ["panel", "trim"] },
    { key: "nearside_rear_door", label: "Nearside Rear Door", surfaces: ["panel", "trim", "glass"] },
    { key: "nearside_front_door", label: "Nearside Front Door", surfaces: ["panel", "trim", "glass"] },
    { key: "nearside_front_quarter", label: "Nearside Front Quarter", surfaces: ["panel", "trim"] },
    { key: "nearside_front_wheel", label: "Nearside Front Wheel", surfaces: ["wheel"] },
    { key: "roof", label: "Roof", surfaces: ["panel", "trim"] },
  ],
  van: [
    { key: "front", label: "Front Area", surfaces: ["panel", "trim"] },
    { key: "bonnet", label: "Bonnet", surfaces: ["panel", "trim"] },
    { key: "windscreen", label: "Windscreen", surfaces: ["glass"] },
    { key: "offside_front_wheel", label: "Offside Front Wheel", surfaces: ["wheel"] },
    { key: "offside_front_quarter", label: "Offside Front Quarter", surfaces: ["panel", "trim"] },
    { key: "offside_front_door", label: "Offside Front Door", surfaces: ["panel", "trim", "glass"] },
    { key: "offside_side_panel", label: "Offside Side Panel", surfaces: ["panel", "trim", "glass"] },
    { key: "offside_rear_panel", label: "Offside Rear Panel", surfaces: ["panel", "trim"] },
    { key: "offside_rear_wheel", label: "Offside Rear Wheel", surfaces: ["wheel"] },
    { key: "rear", label: "Rear Area", surfaces: ["panel", "trim"] },
    { key: "rear_screen", label: "Rear Screen", surfaces: ["glass"] },
    { key: "nearside_rear_wheel", label: "Nearside Rear Wheel", surfaces: ["wheel"] },
    { key: "nearside_rear_panel", label: "Nearside Rear Panel", surfaces: ["panel", "trim"] },
    { key: "nearside_side_panel", label: "Nearside Side Panel", surfaces: ["panel", "trim", "glass"] },
    { key: "nearside_front_door", label: "Nearside Front Door", surfaces: ["panel", "trim", "glass"] },
    { key: "nearside_front_quarter", label: "Nearside Front Quarter", surfaces: ["panel", "trim"] },
    { key: "nearside_front_wheel", label: "Nearside Front Wheel", surfaces: ["wheel"] },
    { key: "roof", label: "Roof", surfaces: ["panel", "trim"] },
  ],
} as const satisfies Record<string, readonly BodySection[]>;

export type BodyType = keyof typeof BODY_SECTIONS;
export const BODY_TYPES = Object.keys(BODY_SECTIONS) as BodyType[];

export const DAMAGE_TYPES: readonly DamageTypeDefinition[] = [
  { key: "alloy_scratched", label: "Alloy Scratched", surfaces: ["wheel"] },
  { key: "alloy_scuffed", label: "Alloy Scuffed", surfaces: ["wheel"] },
  { key: "dent_small", label: "Dent (small)", surfaces: ["panel"] },
  { key: "dent_medium", label: "Dent (medium)", surfaces: ["panel"] },
  { key: "dent_large", label: "Dent (large)", surfaces: ["panel"] },
  { key: "glass_chip", label: "Glass Chipped", surfaces: ["glass"] },
  { key: "glass_crack", label: "Glass Cracked", surfaces: ["glass"] },
  { key: "glass_scratch", label: "Glass Scratched", surfaces: ["glass"] },
  { key: "paint_chip", label: "Paint Chipped", surfaces: ["panel", "trim"] },
  { key: "paint_scuff", label: "Paint Scuffed", surfaces: ["panel", "trim"] },
  { key: "paint_scratch", label: "Paint Scratched", surfaces: ["panel", "trim"] },
  { key: "plastic_chip", label: "Plastic Chipped", surfaces: ["panel", "trim"] },
  { key: "plastic_scuff", label: "Plastic Scuffed", surfaces: ["panel", "trim"] },
  { key: "plastic_scratch", label: "Plastic Scratched", surfaces: ["panel", "trim"] },
  { key: "trim_damage", label: "Trim Damage", surfaces: ["panel", "trim"], requiresNote: true },
  { key: "rust", label: "Rust", surfaces: ["wheel", "panel"] },
] as const;

export const DAMAGE_TYPES_BY_KEY: Record<string, DamageTypeDefinition> = Object.fromEntries(
  DAMAGE_TYPES.map((d) => [d.key, d]),
);

export function bodySectionsFor(bodyType: BodyType): readonly BodySection[] {
  return BODY_SECTIONS[bodyType];
}

export function findBodySection(bodyType: BodyType, sectionKey: string): BodySection | undefined {
  return BODY_SECTIONS[bodyType].find((s) => s.key === sectionKey);
}

/** Damage types offerable on a given section, filtered by shared surface kind. */
export function damageTypesForSection(
  bodyType: BodyType,
  sectionKey: string,
): readonly DamageTypeDefinition[] {
  const section = findBodySection(bodyType, sectionKey);
  if (!section) return [];
  return DAMAGE_TYPES.filter((d) => d.surfaces.some((s) => section.surfaces.includes(s)));
}

/**
 * Whether a (section, damage type) pair is coherent. The database mirrors this
 * as a check constraint helper so an API client cannot record an alloy scuff
 * on a windscreen.
 */
export function isValidFinding(bodyType: BodyType, sectionKey: string, damageTypeKey: string): boolean {
  return damageTypesForSection(bodyType, sectionKey).some((d) => d.key === damageTypeKey);
}

/** The four mandatory walk-around photos captured at every custody event. */
export const APPRAISAL_PHOTO_ANGLES = [
  { key: "ns_front", label: "Nearside Front" },
  { key: "os_front", label: "Offside Front" },
  { key: "ns_rear", label: "Nearside Rear" },
  { key: "os_rear", label: "Offside Rear" },
] as const;

export type AppraisalPhotoAngle = (typeof APPRAISAL_PHOTO_ANGLES)[number]["key"];
