/**
 * The plain line a board control message shows instead of its JSON, as the web app does
 * (`boardNotice` in public/app.js): a goal or status change (`msn.board.v1`) or a brief change
 * (`msn.brief.v1`, ADR 0074). Null for every other message.
 */
export function boardNotice(message: { username: string; contentType?: string | null; text: string }): string | null {
  if (message.contentType !== "application/json") return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(message.text);
    if (!parsed || typeof parsed !== "object") return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    data.schema === "msn.board.v1" &&
    typeof data.goal === "string" &&
    typeof data.status === "string" &&
    ["active", "paused", "complete", "blocked"].includes(data.status)
  )
    return `Goal ${data.status}: ${data.goal}`;
  if (data.schema !== "msn.brief.v1" || !Number.isSafeInteger(data.version) || (data.version as number) < 1) return null;
  const who = typeof data.updatedBy === "string" && data.updatedBy ? data.updatedBy : "The owner";
  return data.cleared === true
    ? `${who} removed the board's brief.`
    : `${who} changed the board's brief (version ${data.version as number}).`;
}
