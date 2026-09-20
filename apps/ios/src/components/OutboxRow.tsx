import { StyleSheet, View } from "react-native";
import type { ChannelController, Draft, OutboxItem } from "../core/channelController.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Button, Text } from "./ui.tsx";

const LABEL: Record<OutboxItem["status"], string> = {
  queued: "Waiting to send…",
  sending: "Sending…",
  uncertain: "Not confirmed",
  rejected: "Not sent",
};

/** An unconfirmed message. Retry re-sends the exact same body under the exact same key. */
export function OutboxRow({
  item,
  channel,
  onEdit,
}: {
  item: OutboxItem;
  channel: ChannelController;
  onEdit: (draft: Draft) => void;
}) {
  const failed = item.status === "uncertain" || item.status === "rejected";
  return (
    <View style={[styles.row, failed && { borderColor: item.status === "rejected" ? colors.danger : colors.warning }]}>
      <Text style={{ fontSize: 15 }} numberOfLines={4}>
        {item.input.text}
      </Text>
      <Text style={{ color: failed ? colors.warning : colors.muted, fontSize: 13 }}>
        {item.input.to ? `To ${item.input.to} · ` : ""}
        {LABEL[item.status]}
        {item.error ? ` — ${item.error}` : ""}
      </Text>
      {failed ? (
        <View style={styles.actions}>
          {item.status === "uncertain" ? (
            <Button label="Retry" onPress={() => channel.retrySend(item.id)} style={{ flex: 1 }} />
          ) : (
            <Button
              label="Edit"
              onPress={() => {
                const draft = channel.takeRejected(item.id);
                if (draft) onEdit(draft);
              }}
              accessibilityHint="Moves it back into the message box"
              style={{ flex: 1 }}
            />
          )}
          <Button label="Discard" variant="danger" onPress={() => channel.discardSend(item.id)} style={{ flex: 1 }} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    padding: spacing.md,
    gap: spacing.sm,
  },
  actions: { flexDirection: "row", gap: spacing.sm },
});
