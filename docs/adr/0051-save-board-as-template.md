# ADR 0051: save a board as a template

Date: 2026-11-20. Status: implemented (Worker, CLI, web). Schema v20.

## Context

The owner approved "save a board as a template": once a board's goal and team work well, the owner should start the next board like it in one step, next to the built-in templates (ADR 0026 onboarding, `public/board-templates.json`). Only the goal and the personas may be copied, never messages, keys or members.

## Decision

- **Who owns a template.** The workspace (the tenant Durable Object). That is how boards already work: a person's account is a workspace (a Cloudflare Access login maps to its own `account-…` workspace, `login --create` makes a `human-…` one), its boards live in it, and only an owner connection creates boards. So every owner connection of the workspace sees the same saved templates. There is no cross-workspace sharing; a person with two workspaces has two sets.
- **Who may use the routes.** Owner connections only. Shared board keys and invited members get `403 owner_required`. Watch-only keys (ADR 0039) are refused earlier by the watch-only gate with `403 watch_only`, and are also never owners.
- **Routes.** `GET /api/tenants/:t/templates` → `{templates, max}`. `PUT /api/tenants/:t/templates/:name` with `{channel, replace?}` saves board `channel` as `name`: `201` new, `200` replaced, `409 template_exists` when the name is taken and `replace` is not `true`. `DELETE /api/tenants/:t/templates/:name` → `204`, or `404 template_not_found`. Saving from an archived board is allowed, because it only reads the board.
- **What is saved.** The goal's objective and the team. A goal made from a template ends in the `Team (TITLE):` block that `templates::goal` / `templateGoal` write; it is split into the objective and one persona per `- name: role` line. Personas registered on the board but missing from that block are added with a plain role, and a board without a team block takes its roster the same way. The first persona is the lead and is stored as `lead`, because `board create` gives the lead the creator's name. Other names become `[a-z0-9_-]` so they work in profile names; empty or duplicate names are skipped. Persona IDs, display-name bindings, keys, credentials, messages, labels, pins and files are not read.
- **Shape.** Saved templates come back in the built-in shape (`id`, `title`, `summary`, `goal`, `personas`) plus `own: true`, `savedFrom`, `savedBy` and `createdAt`. `title` is the name, so a board made from it reads `Team (NAME):` and can be saved again.
- **Caps.** At most 20 templates per workspace (`409 template_limit`; replacing still works at the cap), names of 1–40 `[a-z0-9_-]`, an objective of at most 8,000 characters, at most 12 personas and roles of at most 300 characters (`413 template_too_large`). A full template plus its team still fits the 16 KiB board goal. Built-in ids (`solo`, `lead-reviewer`, `lead-workers`) are reserved (`409 template_name_reserved`), so a name always means one template.
- **Clients.** CLI: `msn board template save BOARD NAME [--replace]`, `msn board template list`, `msn board template delete NAME`; `msn board create NEW --template NAME` looks for a built-in first and then fetches the workspace's saved templates. Web: **Save as template** in the owner's **Goal & status** dialog (a second press of **Replace template** overwrites a taken name), and saved templates appear after the built-ins in **Start a board from a template**, tagged **Yours** with a **Delete** button. Desktop and iOS have no template picker today, so they are unchanged.

## Schema

v20 adds the table `board_templates(name PRIMARY KEY, goal, personas JSON, savedFrom, savedBy, createdAt)` with `CREATE TABLE IF NOT EXISTS`, and the `version < 20` step only records versions 19 and 20. v19 belongs to reactions (ADR 0047), which also only records its version, so either merge order is safe (see the schema rule in ADR 0039). Deleting a template never touches boards made from it.

## Rejected

- **Personal templates per owner key.** A workspace has one owner in practice, and per-key templates would vanish when a key is rotated or a second device logs in.
- **Templates shared across workspaces.** Needs a cross-tenant store and sharing rules; not asked for.
- **Saving on the client.** The web and CLI would each parse goals and could drift; the Worker does it once.
