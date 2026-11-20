import { useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import type { SessionController } from "../core/sessionController.ts";
import { activeMute, MUTE_SPANS, type Mute, type MuteSpan, muteLabel, removeMute, saveMute } from "../core/mutes.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Banner, Button, Segmented, Text } from "./ui.tsx";

/** The owner's mutes, loaded when a board opens (ADR 0044). `null` until the first answer. */
export function useMutes(session: SessionController, channel: string) {
  const [mutes, setMutes] = useState<Mute[] | null>(null);
  useEffect(() => {
    if (!session.owner) return;
    let live = true;
    session.api
      .listMutes()
      .then((list) => live && setMutes(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session, channel]);
  return [mutes, setMutes] as const;
}

/** Header button text for the open board. */
export function muteButtonLabel(mutes: readonly Mute[] | null, channel: string) {
  return muteLabel(mutes ? activeMute(mutes, channel) : null);
}

/** Owner only: mute this board for 1 hour, 1 day or until turned back on. */
export function MutePanel({
  session,
  channel,
  mutes,
  onChange,
}: {
  session: SessionController;
  channel: string;
  mutes: readonly Mute[] | null;
  onChange: (mutes: Mute[]) => void;
}) {
  const current = mutes ? activeMute(mutes, channel) : null;
  const [span, setSpan] = useState<MuteSpan>(current?.until === null ? "forever" : "1h");
  const [everything, setEverything] = useState(current?.everything ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<Mute[]>) => {
    setBusy(true);
    setError(null);
    work()
      .then(onChange)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not change the mute."))
      .finally(() => setBusy(false));
  };
  return (
    <View style={styles.panel}>
      <Text style={styles.note}>
        {current
          ? `${muteLabel(current)}. ${current.everything ? "Nothing on this board notifies you." : "Messages addressed to you still notify."}`
          : "Messages keep arriving on the board. Only notifications to your devices stop."}
      </Text>
      <Segmented options={MUTE_SPANS} value={span} onChange={setSpan} />
      <View style={styles.row}>
        <Text style={{ flex: 1 }}>Also mute messages addressed to me</Text>
        <Switch
          value={everything}
          onValueChange={setEverything}
          accessibilityLabel="Also mute messages addressed to me"
          trackColor={{ true: colors.accent, false: colors.border }}
        />
      </View>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <View style={styles.row}>
        <Button
          variant="primary"
          label={current ? "Update" : "Mute"}
          busy={busy}
          onPress={() => run(() => saveMute(session.api, channel, span, everything))}
        />
        {current ? (
          <Button
            label="Turn back on"
            disabled={busy}
            onPress={() => run(() => removeMute(session.api, channel))}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  note: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
