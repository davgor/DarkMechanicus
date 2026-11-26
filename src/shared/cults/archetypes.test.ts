import { describe, expect, it } from "vitest";
import {
  ARCHETYPE_INFO,
  CULT_ARCHETYPES,
  MAX_DYNAMIC_WORKER_TYPES,
  STANDARD_WORKER_TYPES,
  WORKER_TYPE_INFO,
  createRunWorkerType,
  materializeRoster,
  retireRunWorkerType,
  validateRoster,
  type DynamicWorkerTypeInput,
  type RosterSlot,
  type RunWorkerType,
} from "./archetypes";

const slot = (id: string, over: Partial<RosterSlot> = {}): RosterSlot => ({
  id,
  workerType: "custom",
  label: `Label ${id}`,
  mission: `Mission ${id}`,
  required: true,
  ...over,
});
const codes = (issues: { code: string }[]): string[] =>
  issues.map((i) => i.code);

describe("catalog", () => {
  it("exposes exact archetype and worker type ids in order", () => {
    expect(CULT_ARCHETYPES).toEqual([
      "general",
      "plan_forge",
      "delivery",
      "audit_red_team",
      "research_creative",
      "custom",
    ]);
    expect(STANDARD_WORKER_TYPES).toEqual([
      "ui_ux",
      "implementation_engineering",
      "delivery_scrum",
      "security",
      "quality",
      "architecture_team_lead",
    ]);
    expect(Object.keys(WORKER_TYPE_INFO)).toEqual([
      ...STANDARD_WORKER_TYPES,
      "custom",
    ]);
    for (const info of [
      ...Object.values(WORKER_TYPE_INFO),
      ...Object.values(ARCHETYPE_INFO),
    ]) {
      expect(info.displayName).not.toBe("");
      expect(info.description).not.toBe("");
      expect(info.reviewContract).not.toBe("");
    }
  });
});

describe("materializeRoster", () => {
  it("gives Plan Forge exactly six distinct required standard slots, ignoring supplied slots", () => {
    const roster = materializeRoster("plan_forge", { slots: [slot("x")] });
    expect(roster.map((s) => s.workerType)).toEqual([...STANDARD_WORKER_TYPES]);
    expect(new Set(roster.map((s) => s.id)).size).toBe(6);
    expect(roster.every((s) => s.required)).toBe(true);
    expect(
      validateRoster({ archetype: "plan_forge", slots: roster, cap: 6 }),
    ).toEqual([]);
  });

  it("gives General none and Custom the supplied slots", () => {
    expect(materializeRoster("general")).toEqual([]);
    const supplied = [slot("a"), slot("b")];
    expect(materializeRoster("custom", { slots: supplied })).toEqual(supplied);
    expect(materializeRoster("custom")).toEqual([]);
  });

  it("uses editable defaults for Delivery, Audit and Research, or the edits", () => {
    for (const a of [
      "delivery",
      "audit_red_team",
      "research_creative",
    ] as const) {
      const roster = materializeRoster(a);
      expect(roster).toEqual(ARCHETYPE_INFO[a].preset);
      expect(roster.length).toBeGreaterThan(0);
      expect(
        validateRoster({ archetype: a, slots: roster, cap: roster.length }),
      ).toEqual([]);
      expect(
        materializeRoster(a, { slots: [slot("only")] }).map((s) => s.id),
      ).toEqual(["only"]);
    }
  });

  it("stays immutable after creation even if the source is edited", () => {
    const supplied = [slot("a")];
    const roster = materializeRoster("custom", { slots: supplied });
    supplied[0].label = "changed";
    supplied.push(slot("b"));
    expect(roster).toHaveLength(1);
    expect(roster[0].label).toBe("Label a");
    expect(Object.isFrozen(roster)).toBe(true);
    expect(() => {
      (roster[0] as RosterSlot).mission = "x";
    }).toThrow();
    expect(() => (roster as RosterSlot[]).push(slot("c"))).toThrow();
    const forge = materializeRoster("plan_forge");
    expect(() => {
      (forge[0] as RosterSlot).required = false;
    }).toThrow();
    expect(materializeRoster("plan_forge")[0].required).toBe(true);
  });
});

describe("validateRoster", () => {
  it("rejects duplicate and blank ids, labels and missions", () => {
    const issues = validateRoster({
      archetype: "custom",
      slots: [
        slot("a"),
        slot("a", { label: "L2", mission: "M2" }),
        slot(" ", { label: " ", mission: "" }),
        slot("d", { label: "label A", mission: "mission  a" }),
      ],
      cap: 10,
    });
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        "duplicate_id",
        "blank_id",
        "blank_label",
        "blank_mission",
        "duplicate_label",
        "duplicate_mission",
      ]),
    );
  });

  it("rejects removal, merging, reorder or optional Plan Forge base slots", () => {
    const base = materializeRoster("plan_forge");
    const variants: RosterSlot[][] = [
      base.slice(0, 5),
      [
        ...base.slice(0, 5),
        { ...base[0], id: "ui_ux_2", label: "Second", mission: "Second" },
      ],
      [base[1], base[0], ...base.slice(2)],
      [{ ...base[0], required: false }, ...base.slice(1)],
      [...base, slot("extra")],
    ];
    for (const slots of variants)
      expect(
        codes(validateRoster({ archetype: "plan_forge", slots, cap: 10 })),
      ).toContain("plan_forge_quorum");
  });

  it("rejects a cap below required coverage", () => {
    const forge = materializeRoster("plan_forge");
    expect(
      codes(validateRoster({ archetype: "plan_forge", slots: forge, cap: 5 })),
    ).toEqual(["cap_below_required"]);
    expect(
      codes(
        validateRoster({
          archetype: "custom",
          slots: [slot("a"), slot("b", { required: false })],
          cap: 1,
        }),
      ),
    ).toEqual([]);
    expect(
      codes(validateRoster({ archetype: "general", slots: [], cap: 0 })),
    ).toEqual([]);
    expect(
      codes(
        validateRoster({ archetype: "general", slots: [slot("a")], cap: 1 }),
      ),
    ).toEqual(["general_has_slots"]);
  });
});

const input = (
  displayName: string,
  over: Partial<DynamicWorkerTypeInput> = {},
): DynamicWorkerTypeInput => ({
  displayName,
  description: "d",
  mission: "m",
  rationale: "r",
  requiredForConclusion: false,
  ...over,
});
const ctx = (existing: RunWorkerType[] = []) => ({
  existing,
  creatorMemberId: "mem_1",
  now: "2026-11-26T00:00:00Z",
});
const make = (
  name: string,
  existing: RunWorkerType[] = [],
  over: Partial<DynamicWorkerTypeInput> = {},
): RunWorkerType => {
  const r = createRunWorkerType(input(name, over), ctx(existing));
  if (!r.ok) throw new Error(r.error);
  return r.type;
};

describe("run-scoped dynamic worker types", () => {
  it("assigns a run-local id and normalizes the name", () => {
    const t = make("  Data   Science ");
    expect(t).toMatchObject({
      id: "dyn_1",
      displayName: "Data Science",
      creatorMemberId: "mem_1",
      retiredAt: null,
    });
    expect(make("Other", [t]).id).toBe("dyn_2");
  });

  it("bounds inert fields and rejects blank ones", () => {
    expect(createRunWorkerType(input("x".repeat(81)), ctx()).ok).toBe(false);
    expect(
      createRunWorkerType(input("ok", { mission: "x".repeat(2001) }), ctx()).ok,
    ).toBe(false);
    expect(createRunWorkerType(input("ok", { rationale: " " }), ctx()).ok).toBe(
      false,
    );
  });

  it("rejects built-in and in-run collisions", () => {
    for (const name of [
      "Security",
      "ui ux",
      "UI/UX",
      "quality",
      "Custom",
      "Architecture / Team Lead",
    ])
      expect(createRunWorkerType(input(name), ctx()).ok).toBe(false);
    const t = make("Data");
    expect(createRunWorkerType(input("data"), ctx([t])).ok).toBe(false);
  });
});

describe("run-scoped dynamic worker type limits and lifecycle", () => {
  it("rejects more than 24 types per run", () => {
    const existing: RunWorkerType[] = [];
    for (let i = 0; i < MAX_DYNAMIC_WORKER_TYPES; i++)
      existing.push(make(`T${i}`, existing));
    expect(createRunWorkerType(input("One more"), ctx(existing)).ok).toBe(
      false,
    );
  });

  it("is additive: Plan Forge six still required and valid alongside dynamic types", () => {
    make("Data", [], { requiredForConclusion: true });
    const forge = materializeRoster("plan_forge");
    expect(
      validateRoster({ archetype: "plan_forge", slots: forge, cap: 6 }),
    ).toEqual([]);
    expect(
      codes(
        validateRoster({
          archetype: "plan_forge",
          slots: forge.slice(1),
          cap: 6,
        }),
      ),
    ).toContain("plan_forge_quorum");
  });

  it("keeps required types immutable and retires optional ones only while unassigned", () => {
    const req = make("Req", [], { requiredForConclusion: true });
    expect(Object.isFrozen(req)).toBe(true);
    expect(retireRunWorkerType(req, 0, "later").ok).toBe(false);
    const opt = make("Opt");
    expect(retireRunWorkerType(opt, 1, "later").ok).toBe(false);
    const r = retireRunWorkerType(opt, 0, "later");
    expect(r.ok && r.type.retiredAt).toBe("later");
  });
});
