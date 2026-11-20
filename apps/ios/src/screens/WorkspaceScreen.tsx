import { useState, type ReactNode } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppModel } from "../core/appModel.ts";
import type { ChannelListController, ChannelListState } from "../core/channelList.ts";
import { Store } from "../core/store.ts";
import type { SessionController } from "../core/sessionController.ts";
import { colors, spacing } from "../components/theme.ts";
import { Banner, Button, Text } from "../components/ui.tsx";
import { useChannelList } from "../hooks/useChannelController.ts";
import { useStore } from "../hooks/useStore.ts";
import { ChannelListScreen } from "./ChannelListScreen.tsx";
import { ChannelScreen } from "./ChannelScreen.tsx";

export function confirmSignOut(model: AppModel): void {
  Alert.alert(
    "Sign out?",
    "This stops syncing and discards unsent messages. A saved profile stays on this device so you can switch back to it; choose Forget to delete its access key as well.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", onPress: () => void model.signOut() },
      { text: "Sign out and forget", style: "destructive", onPress: () => void model.signOut(null, { forget: true }) },
    ],
  );
}

/** Shown only for a ready session: the key was verified and the event cursor established. */
export function WorkspaceScreen({
  model,
  session,
  warning,
}: {
  model: AppModel;
  session: SessionController;
  warning: string | null;
}) {
  const connection = useStore(session.state);
  const scoped = session.session.channel;
  const [selected, setSelected] = useState<string | null>(null);
  const channel = scoped ?? selected;
  // One list for the picker and the open board, so the board knows whether it is archived.
  const list = useChannelList(session);
  const lists = useStore(list?.state ?? EMPTY_LIST);
  const archived = channel !== null && lists.channels.some((c) => c.name === channel && c.archivedAt !== null);

  const banner = (
    <>
      {connection.kind === "reconnecting" ? (
        <Banner tone="warning">Reconnecting… {connection.message ?? ""}</Banner>
      ) : null}
      {connection.kind === "failed" ? (
        <Banner
          tone="danger"
          action={connection.retryable ? { label: "Retry", onPress: () => session.retry() } : undefined}
        >
          {connection.message ?? "The connection failed."}
        </Banner>
      ) : null}
      {warning ? <Banner tone="warning">{warning}</Banner> : null}
    </>
  );

  if (channel) {
    return (
      <ChannelScreen
        session={session}
        channel={channel}
        onBack={scoped ? null : () => setSelected(null)}
        banner={banner}
        archived={archived}
        onSetArchived={list && !scoped ? (value) => list.setArchived(channel, value) : undefined}
        trailing={
          scoped ? <Button label="Sign out" variant="ghost" onPress={() => confirmSignOut(model)} /> : undefined
        }
      />
    );
  }
  return <ChannelPicker model={model} session={session} banner={banner} list={list} onSelect={setSelected} />;
}

const EMPTY_LIST = new Store<ChannelListState>({ phase: "loading", channels: [], error: null, unread: new Map() });

function ChannelPicker({
  model,
  session,
  banner,
  list,
  onSelect,
}: {
  model: AppModel;
  session: SessionController;
  banner: ReactNode;
  list: ChannelListController | null;
  onSelect: (channel: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { username, tenant } = session.session;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: insets.bottom }}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {tenant}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 13 }} numberOfLines={1}>
            Signed in as {username}
          </Text>
        </View>
        <Button label="Sign out" variant="ghost" onPress={() => confirmSignOut(model)} />
      </View>
      {banner}
      {list ? <ChannelListScreen list={list} onSelect={onSelect} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 22, fontWeight: "800" },
});
