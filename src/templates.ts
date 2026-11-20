import builtIn from "../public/board-templates.json";
import { HttpError } from "./http";

/** Saved board templates (ADR 0051): a workspace's own goal-and-team presets. */
export const MAX_TEMPLATES = 20;
/** The longest saved objective, in characters. A saved template plus its team still fits a goal. */
export const MAX_TEMPLATE_GOAL = 8000;
export const MAX_TEMPLATE_PERSONAS = 12;
export const MAX_TEMPLATE_ROLE = 300;
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const LEAD_ROLE = "Leads the work toward the board goal and reports progress on the board.";
const MEMBER_ROLE = "Works toward the board goal and reports progress on the board.";

export type TemplatePersona = { name: string; role: string };
export type SavedTemplate = { goal: string; personas: TemplatePersona[] };

/** Built-in template ids from public/board-templates.json. A saved template cannot take one. */
export const BUILT_IN_IDS: ReadonlySet<string> = new Set(builtIn.templates.map((t) => t.id));

export function templateName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new HttpError(
      400,
      "invalid_template_name",
      "Template names are 1–40 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.",
    );
  if (BUILT_IN_IDS.has(value))
    throw new HttpError(
      409,
      "template_name_reserved",
      `${value} is a built-in template. Choose another name.`,
    );
  return value;
}

/** A persona name the CLI can use in a profile name: lowercase `[a-z0-9_-]`, other runs become `-`. */
function personaName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/**
 * Splits a board goal written by a template (`templates::goal` in the CLI, `templateGoal` in
 * public/app.js) into its objective and team. Returns null when the goal has no team block.
 */
export function splitTeam(goal: string): { objective: string; team: TemplatePersona[] } | null {
  const start = goal.lastIndexOf("\n\nTeam (");
  if (start < 0) return null;
  const [header, ...lines] = goal.slice(start + 2).split("\n");
  if (!/^Team \(.+\):$/.test(header) || !lines.length) return null;
  const team: TemplatePersona[] = [];
  for (const line of lines) {
    const match = /^- ([^:\n]+): (.+)$/.exec(line);
    if (!match) return null;
    team.push({ name: match[1], role: match[2].trim() || MEMBER_ROLE });
  }
  return { objective: goal.slice(0, start).trim(), team };
}

/**
 * What a board saves as a template: the objective and the team with roles. Personas registered on
 * the board but missing from the team block join with a plain role. The first persona is the lead
 * and is renamed `lead`, because `board create` gives the lead the creator's own name.
 * Never copies messages, keys or members' connections.
 */
export function templateFromBoard(goal: string, roster: { displayName: string }[]): SavedTemplate {
  const split = splitTeam(goal);
  const objective = (split?.objective ?? goal).trim();
  const raw: TemplatePersona[] = split ? [...split.team] : [];
  for (const persona of roster)
    if (!raw.some((p) => p.name === persona.displayName))
      raw.push({ name: persona.displayName, role: raw.length ? MEMBER_ROLE : LEAD_ROLE });
  if (!raw.length) raw.push({ name: "lead", role: LEAD_ROLE });
  const personas: TemplatePersona[] = [];
  for (const [index, persona] of raw.entries()) {
    const name = index === 0 ? "lead" : personaName(persona.name);
    if (!name || personas.some((p) => p.name === name)) continue;
    personas.push({ name, role: persona.role });
  }
  if (!objective)
    throw new HttpError(400, "template_goal_missing", "Set a board goal before saving it as a template.");
  if ([...objective].length > MAX_TEMPLATE_GOAL)
    throw new HttpError(
      413,
      "template_too_large",
      `The board goal is too long for a template (at most ${MAX_TEMPLATE_GOAL} characters). Shorten it with msn board set first.`,
    );
  if (personas.length > MAX_TEMPLATE_PERSONAS)
    throw new HttpError(
      413,
      "template_too_large",
      `A template holds at most ${MAX_TEMPLATE_PERSONAS} personas; this board has ${personas.length}.`,
    );
  if (personas.some((p) => [...p.role].length > MAX_TEMPLATE_ROLE))
    throw new HttpError(
      413,
      "template_too_large",
      `Each persona role in a template is at most ${MAX_TEMPLATE_ROLE} characters.`,
    );
  return { goal: objective, personas };
}
