# Run a cult

A cult is a timed swarm of Skitarii (OMP) agents: one **Magos** that leads and the **acolytes** it summons. You found
the cult, start a run, talk to the Magos, watch the acolytes work, answer their petitions, and pause, resume, stop or
kill the run. The design, constants and security boundaries are in the [Cults design record](../design/cults.md).

Cults are verified on Windows only (packaged-app verification at the epic acceptance node, DM-621). See the record's
[verification status](../design/cults.md#verification-status-verified-on-windows-only).

Before you start, OMP must be installed and signed in: every member runs on a signed-in OMP chat model.

## Found a cult

1. In the sidebar's **Cults** section, press **Found a cult** (the `+` button).
2. Fill in the dialog:
   - **Name** and **Charter**: the charter is the Magos's first prompt, what the run serves.
   - **Archetype** (see [Archetypes and worker types](#archetypes-and-worker-types)); for Delivery, Audit / Red Team,
     Research / Creative and Custom, edit the roster slots.
   - **Workspace**: a tracked folder, or no folder (a private *sanctum* the app creates and owns). A Plan Forge works in a
     tracked folder, and you also choose its **Target plan** (an epic of that folder).
   - **Magos model** (cheapest first; **Refresh models** asks OMP again) and **Magos name** (or a generated one such as
     "Magos Vettius").
   - **Time limit**: a duration such as `30m`, `90hr`, `2d` or `1d 6h`, at least 1 minute, no upper bound. Units are
     `s`, `m`/`min`, `h`/`hr`, `d`, whole numbers only. Or tick **Unlimited** for a run with no time limit. Only running
     time counts: time spent paused does not.
   - **Acolyte cap**: 1 to 24 (6 to 24 for a Plan Forge), default 6. The most acolytes that may serve at once.
   - **Advanced timings**: **Acolyte grace** (default 3m) and **Magos window** (default 2m), each 30s to 60m. The dialog
     shows the backstop: a run still going grace + window + 1 minute after shutdown starts is killed.
3. Save. The cult appears under **Cults**; open it to see its page.

## Start a run and talk to the Magos

Press **Start** in the command bar. You may override the run's time limit, cap and timings for this run only. The run
goes `starting` → `running`: the Magos is launched with the charter and its cult rules, and the countdown starts (or
"Unlimited · … elapsed").

The comms pane on the right opens on the Magos's terminal, which is interactive: type to it as to any chat. The Magos
summons acolytes itself (`cult_summon_acolyte`), on the cheapest model unless it gives a reason for a higher tier, and
names each one (for example "Acolyte Ferrum-7").

## Watch the acolytes

Each acolyte has a chip in the roster strip under the room. Select a chip to open the **inspector**: name, working or
idle, model, tier and its reason, worker type with its origin and report state, and latest activity. From there:

- **Watch terminal** opens a watch-only tab in the comms pane. It shows the acolyte's terminal but takes no input and
  never resizes it: you cannot type into an acolyte. Talk to the Magos instead.
- **Dismiss** (with a confirm) ends that acolyte.

## Pause, resume, stop, kill

All controls are in the command bar; each end is confirmed.

- **Pause**: every member's current turn is interrupted and told it is paused. The countdown freezes; mail between
  members no longer wakes idle ones. Nothing restarts.
- **Resume**: members are told to continue; the countdown runs again.
- **Stop** ("Stop gracefully"): the run shuts down. The Magos is told to wind down and every acolyte to conclude.
  Acolytes have the acolyte grace to send final reports, then the Magos has its window to write the chronicle and conclude.
  Anyone still running at the backstop (grace + window + 1 minute) is killed. The same happens when the time limit is
  reached or the Magos concludes the run.
- **Kill now**: every member ends at once; the run ends `killed`.
- **Raise**: lift the cap by hand (never past 24).

Each member is asked to exit, sent Ctrl+D after 2 s if it did not, and killed after 5 s. When a run ends, every pending
petition is denied and every right a petition granted is taken back. Ended runs are in **Past runs**, read-only, with
their pipeline and chronicle.

If the Magos's terminal exits on its own while the run is running or paused, the run ends `failed` and its acolytes are
killed.

## Petitions

Only the Magos petitions; each petition appears as a banner over the top of the room with its kind, reason and
**Approve** / **Deny**.

- **More acolytes** (`acolytes`): the Magos hit its cap. Approve a count from 1 to what was asked; the cap rises by that,
  never past 24.
- **Allow save** (`allow_save`): the banner warns that approving lets the Magos save plans and change the board in this
  workspace for the rest of the run. Without it, the Magos cannot save a plan, even of an epic whose run it owns.
- **Folder access** (`folder_access`): names another tracked folder. Approving gives the Magos a separate grant there
  (without Allow save) through a private token file.

All three end with the run: Allow save is switched off, the folder grant revoked and its token file deleted. A crash is
cleaned up the same way at the next start.

## Read the chamber

The room on the left is decorative; every fact in it is also in the roster, inspector and pipeline as text.

- **The Magos at the helm**: it stands on the helm and acts out what it is doing; it is never tinted.
- **Acolytes**: each is a sprite in its roster colour with a name plate. They arrive in a beam on the teleport pad, wander,
  work, and leave through the door.
- **Bubbles**: over an acolyte, its last tool call phrased in a Mechanicus voice, the first line of a mail, or an idle quip.
- **Orders and reports**: a glowing packet flies from the Magos to an acolyte for an order and back for a report; an
  `order_all` sweeps a ring from the helm across the room to every acolyte. Peer mail flies between acolytes.
- **Warnings**: a pending petition and the last minute of a timed run (under 60 s) light up the room.
- **Stasis**: paused, everything freezes.
- **Shutdown and blackout**: while the run shuts down the lights dim once the acolytes have gone; at the end the room
  blacks out. With no active run the room is empty with its lights off.
- **Reduced motion**: with the system reduced-motion setting the room is static, effects are dropped, and orders show as
  outlines.

A Plan Forge page also shows **council coverage**: one item per required type, who holds it, whether it has reported,
and what the conclusion is waiting for.

## Read the pipeline

Open the **Pipeline** tab in the comms pane. It lists every message between the run's members and every run event
(summons, petitions, pause, shutdown, reports, worker types, Shrine), oldest first, each with sender → recipients, time
and kind. An `order_all` reads `<Magos> → all (N)` and expands to its recipients. Filter to one member's entries. A live
run follows the newest entry unless you scroll up. Messages show a 600-character preview; press **Show whole message** to
read one whole.
The pipeline keeps a copy of every body, so it outlives mail retention and departed members. It is read-only: reading it
never marks anything read for the agents.

## The Shrine

Any member can publish what the run makes as the run's **Shrine** with `cult_shrine` and one file in the run's own work
folder: `png`, `jpg`, `jpeg`, `svg` or `html`, at most 10 MiB, no symlink out of the folder. Editing the file updates
the Shrine live. It shows on the room's viewscreen; **Enlarge** opens it large with the file, publisher and update time.

The content is untrusted: images and SVG are shown as images (SVG scripts never run); HTML runs in a sandboxed frame
with no network and no access to the app.

### Example: Gerry the plant

Found a **Research / Creative** cult with no folder, a 2h time limit and this charter:

> Build a Shrine for Gerry, the office's potted fern. Make one self-contained `gerry.html` in the work folder: an
> animated portrait of Gerry, today's watering status, and a short heroic biography. No network requests, no external
> files. Publish it as the Shrine early and keep improving it. UI/UX owns the look, implementation engineering the
> page, quality checks it renders and stays self-contained. Conclude when all three have reported.

The Magos summons the three slot acolytes, one of them writes `gerry.html` and publishes it with `cult_shrine`, and the
viewscreen updates each time the file changes.

## Archetypes and worker types

A **worker type** is the professional perspective an acolyte reviews from. It changes only the acolyte's mission and
rules: it is not its authority (every acolyte holds the same `worker` grant) and not a ticket's `workType` (which routes
tickets to agents).

| Worker type | Reviews |
| --- | --- |
| UI/UX (`ui_ux`) | journeys, information architecture, interaction, accessibility and visual evidence |
| Implementation engineering (`implementation_engineering`) | source architecture, interfaces, dependencies, feasibility and implementation risks |
| Delivery/Scrum (`delivery_scrum`) | scope, ticket boundaries, graph, sequencing, resource risk and likelihood of success |
| Security (`security`) | authority, trust boundaries, privacy, abuse cases, unsafe defaults and mitigations |
| Quality (`quality`) | acceptance, deterministic tests, end-to-end proof, failure cases and release evidence |
| Architecture/team lead (`architecture_team_lead`) | boundaries, integration, tradeoffs, maintainability and conflicts between recommendations |
| Custom (`custom`) | the mission you wrote for that slot |

| Archetype | Roster | Defaults or enforced |
| --- | --- | --- |
| **General** | none: the Magos chooses who to summon | no slots allowed |
| **Plan Forge** | the six types above (not Custom), in order, all required | **enforced**: cannot be edited; cap at least 6 |
| **Delivery** | Architecture/team lead, Implementation engineering, Quality, Delivery/Scrum | defaults you may edit |
| **Audit / Red Team** | Security, Quality, Architecture/team lead, Implementation engineering, each analysis-only | defaults you may edit |
| **Research / Creative** | UI/UX, Implementation engineering, Quality | defaults you may edit |
| **Custom** | the slots you write | you supply them |

A roster's slot ids, labels and missions must be unique and the cap at least the number of required slots. Required
slots must report before the Magos may conclude (`reports_missing` otherwise).

## Plan Forge, end to end

A Plan Forge cult has six independent specialists review and improve one epic plan, then the Magos merges their
recommendations into one validated draft. Saving stays your decision.

1. **Choose the folder and target.** Found a **Plan Forge** cult in a tracked folder and pick the **Target plan**. The
   cap is at least 6.
2. **Start.** The run is bound to the target's current saved and draft revisions before the Magos starts.
3. **Six independent reports.** The Magos summons exactly one acolyte per slot. Each reads and validates the target and
   sends its report (evidence, risks, recommendations, acceptance impact, blockers) with `cult_conclude_service`. No report
   is passed to another specialist before it has reported. Watch them arrive in council coverage and the pipeline.
4. **Conflicts resolved.** The Magos names each conflict between recommendations and its decision, makes one edit of the
   target draft applying the reports, validates it, and records its **synthesis** (`cult_record_synthesis`): every
   recommendation accepted or rejected, with its worker type and a reason, naming every required type.
5. **Review the validated draft.** Open the epic's draft in the plan view. Acolytes never edited it: their `worker`
   grants cannot edit drafts or save. Only the Magos's edits are accepted by the council.
6. **Allow save, optional.** To save, the Magos petitions **Allow save**. Approve it and the Magos may press Save; deny
   it and the draft stays unsaved for you to save yourself.
7. **Conclusion.** The Magos concludes with `cult_conclude_run`; the run then shuts down as under Stop.

The conclusion is refused, and the run keeps running, when:

- `target_stale`: someone outside the run changed or saved the target since the binding. Re-read the target; if the
  change was wrong, revert it, otherwise stop the run and start a new one, which binds to the new revisions.
- `reports_missing`: a required type has no report from its own acolyte. The refusal lists the missing types; the Magos
  summons or orders that specialist and waits for its report.
- `synthesis_missing`: no synthesis for the Magos's latest draft edit, it misses a required type, or the latest draft
  revision was not the Magos's. The Magos records a fresh synthesis for its latest edit.
- `plan_invalid`: the draft does not validate; the refusal carries up to 20 errors to fix.

## A Magos-created specialist, end to end

When the roster lacks a perspective the charter materially needs, the Magos may create a worker type for this run.

Example: a Plan Forge for an epic that adds a translated UI. The fixed six do not cover translation, so the Magos:

1. **Creates** it: `cult_create_worker_type` with display name "Localization", a description, a mission ("Review
   string extraction, pluralization, locale formatting and translation workflow"), a rationale ("No fixed slot covers
   localization, and the charter adds three locales") and `requiredForConclusion: true`. The app gives it an id such as
   `dyn_1`; the pipeline records `worker_type_created`, and the roster and council coverage show it as Magos-created,
   required.
2. **Summons** an acolyte of it with `cult_summon_acolyte`, under the same cap (petition for more if the cap is full),
   on the cheapest model unless it gives a tier reason.
3. **Reports**: the Localization acolyte reports like the six; the conclusion now also waits for it, and the synthesis
   must name it.

Rules:

- **Run scope**: the type exists for this run only. A new run of the cult starts without it; the cult definition never
  gains it. `cult_list_worker_types` lists this run's types and who held each.
- **Required types are irreversible**: a required type can never be retired (`worker_type_required`). An optional type
  can be retired with `cult_retire_worker_type` and a reason only while no acolyte has ever held it
  (`worker_type_assigned`), and never gates conclusion.
- **It never replaces a Plan Forge slot**: the six stay as they are and each still needs its own report; a created type
  is added beside them.
- **Authority and cap unchanged**: a created type adds no permission, grant, folder, Save right, model or tier. Its
  acolytes hold `worker` grants under the same cap and petition rules.
- **Creation cap**: at most 24 created types per run, **counting retired ones** (`worker_type_limit`). Names that collide
  with a built-in type or one already in the run are refused (`worker_type_name_taken`).

## What happens on quit

Quitting the app while a run is live ends it: every member is ended at once and the run ends `interrupted`. If the app
crashed instead, the next start marks such runs `interrupted`, ends any member process still running, and revokes every
right a petition granted. A run cannot be resumed after quit; start a new run.

## Troubleshooting

- **OMP signed out or not installed**: the Magos model list is empty with "OMP is not connected, so no model can be
  offered." Sign in to OMP, then press **Refresh models**. There is never a fallback model.
- **No models**: OMP is signed in but lists no chat model for your providers, or did not answer in time. Check `omp
  models` in a terminal, then **Refresh models**.
- **Cap reached**: the Magos's summon is refused with `cap_reached`. It petitions for more acolytes; approve the banner,
  or press **Raise**. The cap never exceeds 24.
- **The Magos is quiet while paused**: a paused run does not wake members; press **Resume**.
- **A Shrine does not appear**: the file must be one `png`, `jpg`, `jpeg`, `svg` or `html` file of at most 10 MiB inside
  the run's work folder (`shrine_refused` otherwise).
