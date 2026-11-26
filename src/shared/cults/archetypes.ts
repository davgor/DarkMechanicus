/**
 * Cult archetypes, worker types and roster validation: the pure taxonomy every cult layer consumes.
 * Worker types are professional perspectives, deliberately separate from the dispatch `WORK_TYPES`.
 * No database, Electron or renderer imports.
 */

export const CULT_ARCHETYPES = [
  "general",
  "plan_forge",
  "delivery",
  "audit_red_team",
  "research_creative",
  "custom",
] as const;
export type CultArchetype = (typeof CULT_ARCHETYPES)[number];

export const STANDARD_WORKER_TYPES = [
  "ui_ux",
  "implementation_engineering",
  "delivery_scrum",
  "security",
  "quality",
  "architecture_team_lead",
] as const;
export type StandardWorkerType = (typeof STANDARD_WORKER_TYPES)[number];

/** A user-defined slot perspective; its label and mission carry the meaning. */
export const CUSTOM_WORKER_TYPE = "custom";
export type WorkerType = StandardWorkerType | typeof CUSTOM_WORKER_TYPE;

export interface WorkerTypeInfo {
  displayName: string;
  description: string;
  /** What this perspective must check before work it touches may conclude. */
  reviewContract: string;
}

export const WORKER_TYPE_INFO: Readonly<Record<WorkerType, WorkerTypeInfo>> = {
  ui_ux: {
    displayName: "UI/UX",
    description:
      "Shapes what the person sees and does: flows, layout, accessibility and copy.",
    reviewContract:
      "Confirms every user-facing change is usable, accessible and consistent with the existing interface.",
  },
  implementation_engineering: {
    displayName: "Implementation Engineering",
    description:
      "Builds the change: code, data shapes and integration with existing modules.",
    reviewContract:
      "Confirms the change is buildable, minimal and reuses existing patterns without dead code.",
  },
  delivery_scrum: {
    displayName: "Delivery / Scrum",
    description:
      "Sequences work into deliverable slices, tracks dependencies and keeps scope honest.",
    reviewContract:
      "Confirms each slice is independently verifiable and dependencies and order are explicit.",
  },
  security: {
    displayName: "Security",
    description:
      "Finds trust boundaries, secrets, permissions and abuse paths.",
    reviewContract:
      "Confirms no secret leaks, permission widening or unvalidated input crosses a trust boundary.",
  },
  quality: {
    displayName: "Quality",
    description: "Designs tests and evidence that prove each criterion.",
    reviewContract:
      "Confirms every criterion has a concrete test case with starting condition, action and expected result.",
  },
  architecture_team_lead: {
    displayName: "Architecture / Team Lead",
    description:
      "Owns module boundaries, contracts and the coherence of the whole plan.",
    reviewContract:
      "Confirms contracts are stable, boundaries are respected and the parts compose into the intended outcome.",
  },
  custom: {
    displayName: "Custom",
    description:
      "A user-defined perspective described by its slot label and mission.",
    reviewContract:
      "Confirms the work satisfies the mission written for this slot.",
  },
};

/** One ordered seat in a cult roster. */
export interface RosterSlot {
  /** Stable within the roster; persistence keys on it. */
  id: string;
  workerType: WorkerType;
  label: string;
  mission: string;
  /** Required slots count toward the acolyte cap's minimum coverage. */
  required: boolean;
}

export type PresetKind = "none" | "fixed" | "editable_defaults" | "supplied";

export interface ArchetypeInfo {
  displayName: string;
  description: string;
  reviewContract: string;
  presetKind: PresetKind;
  /** Ordered default slots; empty for General and Custom. */
  preset: readonly RosterSlot[];
}

const standardSlot = (
  workerType: StandardWorkerType,
  mission: string,
  required = true,
): RosterSlot =>
  Object.freeze({
    id: workerType,
    workerType,
    label: WORKER_TYPE_INFO[workerType].displayName,
    mission,
    required,
  });

const PLAN_FORGE_PRESET: readonly RosterSlot[] = Object.freeze([
  standardSlot(
    "ui_ux",
    "Plan the user-facing experience and its acceptance criteria.",
  ),
  standardSlot(
    "implementation_engineering",
    "Plan the code changes, modules and data shapes.",
  ),
  standardSlot(
    "delivery_scrum",
    "Slice the plan into sprints and tickets with explicit dependencies.",
  ),
  standardSlot(
    "security",
    "Plan trust boundaries, permissions and secret handling.",
  ),
  standardSlot(
    "quality",
    "Plan test cases and verification for every criterion.",
  ),
  standardSlot(
    "architecture_team_lead",
    "Own contracts and integrate the specialists into one coherent plan.",
  ),
]);

export const ARCHETYPE_INFO: Readonly<Record<CultArchetype, ArchetypeInfo>> = {
  general: {
    displayName: "General",
    description:
      "A Magos with no preset specialists; acolytes are summoned as the work demands.",
    reviewContract: "The Magos confirms the stated goal is met.",
    presetKind: "none",
    preset: Object.freeze([]),
  },
  plan_forge: {
    displayName: "Plan Forge",
    description:
      "Six distinct specialists forge one reviewed plan from a goal.",
    reviewContract:
      "Every one of the six specialists reviews the plan before it concludes.",
    presetKind: "fixed",
    preset: PLAN_FORGE_PRESET,
  },
  delivery: {
    displayName: "Delivery",
    description: "Builds and ships accountable work against a plan.",
    reviewContract:
      "Implementation, quality and delivery confirm the work is built, tested and sequenced.",
    presetKind: "editable_defaults",
    preset: Object.freeze([
      standardSlot("implementation_engineering", "Build the planned changes."),
      standardSlot("quality", "Prove each change with tests."),
      standardSlot("delivery_scrum", "Sequence and track the work to done."),
    ]),
  },
  audit_red_team: {
    displayName: "Audit / Red Team",
    description: "Attacks and audits existing work for weaknesses.",
    reviewContract:
      "Security and quality confirm each finding is evidenced and reproducible.",
    presetKind: "editable_defaults",
    preset: Object.freeze([
      standardSlot("security", "Find and evidence exploitable weaknesses."),
      standardSlot("quality", "Find and reproduce defects and coverage gaps."),
      standardSlot(
        "architecture_team_lead",
        "Judge structural risk and prioritize findings.",
      ),
    ]),
  },
  research_creative: {
    displayName: "Research / Creative",
    description:
      "Explores options and produces ideas, prototypes and findings.",
    reviewContract:
      "The lead confirms findings are sourced and options are compared.",
    presetKind: "editable_defaults",
    preset: Object.freeze([
      standardSlot(
        "architecture_team_lead",
        "Frame the question and compare options.",
      ),
      standardSlot("ui_ux", "Explore experience and creative directions."),
    ]),
  },
  custom: {
    displayName: "Custom",
    description: "A roster the person defines slot by slot.",
    reviewContract: "Each required slot reviews against its own mission.",
    presetKind: "supplied",
    preset: Object.freeze([]),
  },
};

export interface MaterializeRosterInput {
  /** Replaces the defaults for Delivery, Audit and Research; the whole roster for Custom. Ignored by Plan Forge and General. */
  slots?: readonly RosterSlot[];
}

/** Freezes a deep copy so a run's roster can never change after creation. */
const freezeRoster = (slots: readonly RosterSlot[]): readonly RosterSlot[] =>
  Object.freeze(slots.map((slot) => Object.freeze({ ...slot })));

/** The roster a run starts with. Pure; the result is deeply frozen. Validate it with `validateRoster`. */
export function materializeRoster(
  archetype: CultArchetype,
  input: MaterializeRosterInput = {},
): readonly RosterSlot[] {
  const info = ARCHETYPE_INFO[archetype];
  switch (info.presetKind) {
    case "none":
    case "fixed":
      return freezeRoster(info.preset);
    case "editable_defaults":
      return freezeRoster(input.slots ?? info.preset);
    case "supplied":
      return freezeRoster(input.slots ?? []);
  }
}

export interface RosterIssue {
  code:
    | "blank_id"
    | "duplicate_id"
    | "blank_label"
    | "duplicate_label"
    | "blank_mission"
    | "duplicate_mission"
    | "unknown_worker_type"
    | "plan_forge_quorum"
    | "general_has_slots"
    | "cap_below_required";
  message: string;
  slotId?: string;
}

export interface ValidateRosterInput {
  archetype: CultArchetype;
  slots: readonly RosterSlot[];
  /** Maximum concurrent acolytes for the run. */
  cap: number;
}

const norm = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

const isWorkerType = (value: string): value is WorkerType =>
  value === CUSTOM_WORKER_TYPE ||
  (STANDARD_WORKER_TYPES as readonly string[]).includes(value);

/** Reports blank and duplicate (whitespace/case-insensitive) values of one slot field. */
function checkUnique(
  slots: readonly RosterSlot[],
  field: "id" | "label" | "mission",
  issues: RosterIssue[],
): void {
  const seen = new Set<string>();
  for (const slot of slots) {
    const value = norm(slot[field]);
    if (!value)
      issues.push({
        code: `blank_${field}`,
        message: `Slot ${field} must not be blank.`,
        slotId: slot.id,
      });
    else if (seen.has(value))
      issues.push({
        code: `duplicate_${field}`,
        message: `Slot ${field} "${slot[field].trim()}" is used twice.`,
        slotId: slot.id,
      });
    else seen.add(value);
  }
}

/**
 * Checks a roster against its archetype. Run-scoped dynamic types live outside the roster and are
 * additive, so they neither satisfy nor disturb the Plan Forge six.
 */
export function validateRoster({
  archetype,
  slots,
  cap,
}: ValidateRosterInput): RosterIssue[] {
  const issues: RosterIssue[] = [];
  checkUnique(slots, "id", issues);
  checkUnique(slots, "label", issues);
  checkUnique(slots, "mission", issues);

  for (const slot of slots) {
    if (!isWorkerType(slot.workerType))
      issues.push({
        code: "unknown_worker_type",
        message: `Unknown worker type "${slot.workerType}".`,
        slotId: slot.id,
      });
  }

  if (archetype === "general" && slots.length > 0)
    issues.push({
      code: "general_has_slots",
      message: "General cults have no preset slots.",
    });

  if (archetype === "plan_forge") {
    const base = ARCHETYPE_INFO.plan_forge.preset;
    const intact =
      slots.length === base.length &&
      base.every((b, i) => {
        const s = slots[i];
        return s.id === b.id && s.workerType === b.workerType && s.required;
      });
    if (!intact)
      issues.push({
        code: "plan_forge_quorum",
        message:
          "Plan Forge requires exactly its six distinct standard slots, in order and required.",
      });
  }

  const required = slots.filter((s) => s.required).length;
  if (!Number.isInteger(cap) || cap < required)
    issues.push({
      code: "cap_below_required",
      message: `Cap ${cap} is below the ${required} required slots.`,
    });

  return issues;
}

// ---- Run-scoped dynamic worker types (revision 5) ----

export const MAX_DYNAMIC_WORKER_TYPES = 24;
export const DYNAMIC_TYPE_LIMITS = {
  displayName: 80,
  description: 500,
  mission: 2000,
  rationale: 1000,
} as const;

/** What a member proposes; inert text only. */
export interface DynamicWorkerTypeInput {
  displayName: string;
  description: string;
  /** Mission and review contract for acolytes of this type. */
  mission: string;
  rationale: string;
  requiredForConclusion: boolean;
}

export interface RunWorkerType {
  /** App-generated, stable within the run; never a built-in id. */
  id: string;
  displayName: string;
  description: string;
  mission: string;
  rationale: string;
  requiredForConclusion: boolean;
  creatorMemberId: string;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface DynamicTypeContext {
  existing: readonly RunWorkerType[];
  creatorMemberId: string;
  /** ISO timestamp. */
  now: string;
}

export type DynamicTypeResult =
  { ok: true; type: RunWorkerType } | { ok: false; error: string };

const BUILT_IN_IDS: ReadonlySet<string> = new Set<string>([
  ...STANDARD_WORKER_TYPES,
  CUSTOM_WORKER_TYPE,
]);
const BUILT_IN_NAMES: ReadonlySet<string> = new Set(
  Object.values(WORKER_TYPE_INFO).map((info) => norm(info.displayName)),
);

/** Trims and bounds the inert text fields; returns the refusal reason as a string. */
function normalizeDynamicFields(
  input: DynamicWorkerTypeInput,
): Record<keyof typeof DYNAMIC_TYPE_LIMITS, string> | string {
  const fields = {
    displayName: input.displayName.trim().replace(/\s+/g, " "),
    description: input.description.trim(),
    mission: input.mission.trim(),
    rationale: input.rationale.trim(),
  };
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (!fields[key]) return `${key} must not be blank.`;
    if (fields[key].length > DYNAMIC_TYPE_LIMITS[key])
      return `${key} exceeds ${DYNAMIC_TYPE_LIMITS[key]} characters.`;
  }
  return fields;
}

/** Validates a proposed type and returns it with a run-local id (`dyn_<n>`), or the reason it is refused. */
export function createRunWorkerType(
  input: DynamicWorkerTypeInput,
  ctx: DynamicTypeContext,
): DynamicTypeResult {
  if (ctx.existing.length >= MAX_DYNAMIC_WORKER_TYPES)
    return {
      ok: false,
      error: `A run may create at most ${MAX_DYNAMIC_WORKER_TYPES} worker types.`,
    };
  const fields = normalizeDynamicFields(input);
  if (typeof fields === "string") return { ok: false, error: fields };
  const name = norm(fields.displayName);
  if (
    BUILT_IN_NAMES.has(name) ||
    BUILT_IN_IDS.has(name.replace(/[\s/-]+/g, "_"))
  )
    return {
      ok: false,
      error: `"${fields.displayName}" collides with a built-in worker type.`,
    };
  if (ctx.existing.some((t) => norm(t.displayName) === name))
    return {
      ok: false,
      error: `"${fields.displayName}" already exists in this run.`,
    };
  if (!ctx.creatorMemberId.trim())
    return { ok: false, error: "creatorMemberId must not be blank." };
  return {
    ok: true,
    type: Object.freeze({
      id: `dyn_${ctx.existing.length + 1}`,
      ...fields,
      requiredForConclusion: input.requiredForConclusion,
      creatorMemberId: ctx.creatorMemberId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      retiredAt: null,
    }),
  };
}

/** Required types are immutable; optional types retire only while no acolyte holds them. */
export function retireRunWorkerType(
  type: RunWorkerType,
  assignedCount: number,
  now: string,
): DynamicTypeResult {
  if (type.requiredForConclusion)
    return { ok: false, error: "A required worker type cannot be retired." };
  if (assignedCount > 0)
    return { ok: false, error: "A worker type cannot retire while assigned." };
  if (type.retiredAt)
    return { ok: false, error: "Worker type is already retired." };
  return {
    ok: true,
    type: Object.freeze({ ...type, retiredAt: now, updatedAt: now }),
  };
}
