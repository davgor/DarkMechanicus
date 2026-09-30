# EPIC: Named capability profiles

`initializeRepository` creates `.darkmechanicus/profiles/`, and tickets carry inline capability profiles, but there is no way to save and reuse a named profile ("ui-implementation", "deep-review"). Add named, provider-neutral profiles stored as portable records that tickets can start from. Follow-up from ticket 011.3.

## Acceptance criteria

- [ ] `list_profiles`, `get_profile`, `save_profile` commands with schema validation and path containment (tested)
- [ ] The ticket editor can apply a named profile to a ticket's capability requirements (tested)
- [ ] Profiles import on reconcile like other tracked records, rejecting hostile files (tested)
