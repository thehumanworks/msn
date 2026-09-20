/** Everything needed to talk to one workspace as one participant. Never logged, never in a URL. */
export type Session = {
  origin: string;
  tenant: string;
  token: string;
  /** The display name this device sends as (always set; a bound key fixes it). */
  username: string;
  /** Present when the key may only send names with this prefix. */
  usernamePrefix: string | null;
  /** Present only for a channel-scoped access key (invite redemption); restricts the whole UI. */
  channel?: string;
};
