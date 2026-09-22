/**
 * The vehicle appraisal checklist, carried over from the legacy YVM build
 * (`src/strings/job.ts` and the Yup schemas in the driver app's
 * `schema/job-schema.ts`).
 *
 * This is stored on a custody event as a jsonb `appraisal` document rather than
 * as sixty columns, because the checklist changes shape over time and old
 * events must keep rendering exactly as they were captured. The field
 * definitions here are what validates a submission and what the PDF renderer
 * walks to lay out a certificate.
 */

export type AppraisalFieldType = "text" | "number" | "choice" | "boolean";

export interface AppraisalField {
  key: string;
  label: string;
  type: AppraisalFieldType;
  /** Allowed values for a `choice` field, in display order. */
  options?: readonly string[];
  required?: boolean;
  /** Only shown when this other field holds one of the listed values. */
  showWhen?: { field: string; oneOf: readonly string[] };
  /** Forced to the first option when this other field is answered. */
  clearedBy?: string;
  help?: string;
}

const YES_NO = ["Yes", "No"] as const;
const LEVELS = ["N/A", "Empty", "1/4", "1/2", "3/4", "Full"] as const;

/**
 * Asked once, before a vehicle is collected. A "No" on fluid levels, tyres,
 * MOT or wipers and lights is a roadworthiness problem: the legacy system put
 * the whole job on hold and made the driver call the office, and that
 * behaviour is worth keeping.
 */
export const PRE_COLLECTION_SURVEY: readonly AppraisalField[] = [
  { key: "fluid_levels", label: "Are all fluid levels correct", type: "choice", options: YES_NO, required: true },
  { key: "tyre_legal", label: "Are all tyres legal", type: "choice", options: YES_NO, required: true },
  { key: "valid_mot", label: "Does the vehicle have a valid MOT", type: "choice", options: YES_NO, required: true },
  {
    key: "mot_booked",
    label: "Is the vehicle booked in for an MOT",
    type: "choice",
    options: YES_NO,
    required: true,
    showWhen: { field: "valid_mot", oneOf: ["No"] },
  },
  {
    key: "wipers_lights",
    label: "Are all wipers and lights present and working",
    type: "choice",
    options: YES_NO,
    required: true,
  },
] as const;

/** Survey answers that put the vehicle on hold rather than letting it move. */
export const HOLD_TRIGGERING_ANSWERS: readonly { field: string; value: string; reason: string }[] = [
  { field: "fluid_levels", value: "No", reason: "Fluid levels are not correct" },
  { field: "tyre_legal", value: "No", reason: "One or more tyres are not legal" },
  { field: "valid_mot", value: "No", reason: "Vehicle does not have a valid MOT" },
  { field: "wipers_lights", value: "No", reason: "Wipers or lights are missing or not working" },
] as const;

export const APPRAISAL_FIELDS: readonly AppraisalField[] = [
  {
    key: "odometer",
    label: "Mileage",
    type: "number",
    required: true,
    help: "Read from the instrument cluster. A dashboard photo is captured alongside this.",
  },
  { key: "fuel_level", label: "Fuel Level", type: "choice", options: LEVELS, required: true, clearedBy: "charge_level" },
  { key: "charge_level", label: "Charge Level", type: "choice", options: LEVELS, required: true, clearedBy: "fuel_level" },
  { key: "keys", label: "Number of keys", type: "number", required: true },
  { key: "wheel_nut", label: "Locking wheel nut", type: "choice", options: YES_NO, required: true },
  { key: "number_plates", label: "Number plates present and match", type: "choice", options: YES_NO, required: true },
  { key: "warning_light", label: "Warning lights on", type: "choice", options: YES_NO, required: true },
  { key: "sat_nav", label: "Sat nav present and working", type: "choice", options: [...YES_NO, "N/A"], required: true },
  { key: "parcel_shelf", label: "Parcel shelf present", type: "choice", options: [...YES_NO, "N/A"], required: true },
  { key: "mats", label: "Mats in place", type: "choice", options: [...YES_NO, "N/A"], required: true },
  { key: "spare_wheel", label: "Spare wheel / tyre inflation / run flats", type: "choice", options: [...YES_NO, "N/A"], required: true },
  { key: "jack", label: "Jack", type: "choice", options: [...YES_NO, "N/A"], required: true },
  { key: "tools", label: "Tools", type: "choice", options: [...YES_NO, "N/A"], required: true },
  {
    key: "charging_cable",
    label: "Charging cable(s)",
    type: "choice",
    options: YES_NO,
    showWhen: { field: "charge_level", oneOf: ["Empty", "1/4", "1/2", "3/4", "Full"] },
  },
  {
    key: "cable_number",
    label: "No. of charging cables",
    type: "number",
    showWhen: { field: "charging_cable", oneOf: ["Yes"] },
  },
  { key: "v5", label: "V5 present", type: "choice", options: YES_NO, required: true },
  { key: "light", label: "Light", type: "choice", options: ["Dark", "Dull", "Bright"], required: true },
  { key: "weather", label: "Weather", type: "choice", options: ["Ice", "Wet", "Damp", "Dry"], required: true },
] as const;

export const APPRAISAL_FIELDS_BY_KEY: Record<string, AppraisalField> = Object.fromEntries(
  APPRAISAL_FIELDS.map((f) => [f.key, f]),
);

/** Sign-off questions asked of the driver before handing the device over. */
export const DRIVER_SIGN_OFF_FIELDS: readonly AppraisalField[] = [
  { key: "clean_internally", label: "Clean internally", type: "choice", options: YES_NO, required: true },
  { key: "clean_externally", label: "Clean externally", type: "choice", options: YES_NO, required: true },
  { key: "handbook", label: "Manufacturers handbook in vehicle", type: "choice", options: YES_NO, required: true },
  { key: "comments", label: "Driver comments", type: "text" },
] as const;

/** Additional questions asked only at a final delivery. */
export const DELIVERY_SIGN_OFF_FIELDS: readonly AppraisalField[] = [
  { key: "washed", label: "Has the vehicle been washed before delivery", type: "choice", options: YES_NO, required: true },
  {
    key: "additional_paperwork",
    label: "Has any additional paperwork been completed",
    type: "choice",
    options: YES_NO,
    required: true,
  },
] as const;

/** Questions the receiving party answers at a final delivery. */
export const HANDOVER_FIELDS: readonly AppraisalField[] = [
  { key: "handover", label: "Is a full vehicle handover required", type: "choice", options: YES_NO, required: true },
  {
    key: "controls_explained",
    label: "Did the driver offer to explain the vehicle controls",
    type: "choice",
    options: YES_NO,
    showWhen: { field: "handover", oneOf: ["Yes"] },
  },
  {
    key: "controls_explained_satisfactory",
    label: "Were vehicle controls explained to your satisfaction",
    type: "choice",
    options: YES_NO,
    showWhen: { field: "handover", oneOf: ["Yes"] },
  },
  { key: "satisfied", label: "Are you satisfied with your delivery", type: "choice", options: YES_NO, required: true },
  {
    key: "comments",
    label: "Comments about delivery",
    type: "text",
    showWhen: { field: "satisfied", oneOf: ["No"] },
  },
] as const;
