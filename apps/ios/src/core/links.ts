/**
 * Links to a single message (ADR 0042). `ORIGIN/#board=TENANT/CHANNEL&msg=ID` opens the web app
 * on that board, scrolled to the message and highlighted. The same form as the web app, the CLI
 * (`msn link`) and the desktop client. A link names a message, never a credential: whoever opens
 * it reads with their own access.
 */
export function messageLink(origin: string, tenant: string, channel: string, id: number): string {
  return `${new URL(origin).origin}/#board=${tenant}/${channel}&msg=${id}`;
}
