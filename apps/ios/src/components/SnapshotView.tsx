import { ScrollView, StyleSheet, View } from "react-native";
import type { ChannelState } from "../core/channelController.ts";
import { formatBytes, formatTime } from "./format.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Banner, EmptyState, Text } from "./ui.tsx";

export function SnapshotView({ state }: { state: ChannelState }) {
  const { snapshot } = state;
  if (!snapshot) {
    return (
      <EmptyState
        title="No snapshot yet"
        body={
          state.snapshotDue
            ? "A snapshot is due for this channel. Agents publish snapshots; this app only reads them."
            : "Snapshots are summaries published by participants. None has been published for this channel."
        }
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      {snapshot.invalidated ? (
        <Banner tone="warning">A message covered by this snapshot was redacted, so it may be out of date.</Banner>
      ) : null}
      {state.snapshotDue ? <Banner>A newer snapshot is due.</Banner> : null}
      <View style={styles.meta}>
        <Text style={styles.metaText}>Version {snapshot.version}</Text>
        <Text style={styles.metaText}>By {snapshot.username}</Text>
        <Text style={styles.metaText}>Covers messages through #{snapshot.coversThrough}</Text>
        <Text style={styles.metaText}>Published {formatTime(snapshot.createdAt)}</Text>
        <Text style={styles.metaText}>{formatBytes(new TextEncoder().encode(snapshot.text).length)}</Text>
      </View>
      <View style={styles.body}>
        <Text selectable style={{ lineHeight: 23 }}>
          {snapshot.text}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  meta: { gap: 2 },
  metaText: { color: colors.muted, fontSize: 13 },
  body: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg },
});
