import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Draft } from "../core/channelController.ts";
import type { SessionController } from "../core/sessionController.ts";
import { loadReceipts, type Receipt, RECEIPTS_EVERY_MS, receiptLine } from "../core/receipts.ts";
import type { Message } from "../core/types.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageRow } from "../components/MessageRow.tsx";
import { OutboxRow } from "../components/OutboxRow.tsx";
import { SearchView } from "../components/SearchView.tsx";
import { SnapshotView } from "../components/SnapshotView.tsx";
import { TaskActivityView } from "../components/TaskActivityView.tsx";
import { colors, spacing } from "../components/theme.ts";
import { Banner, Button, EmptyState, Segmented, Text } from "../components/ui.tsx";
import { useChannel } from "../hooks/useChannelController.ts";
import { useStore } from "../hooks/useStore.ts";

type Tab = "chat" | "search" | "snapshot" | "tasks";

const TABS = [
  { value: "chat", label: "Chat" },
  { value: "search", label: "Search" },
  { value: "snapshot", label: "Snapshot" },
  { value: "tasks", label: "Task activity" },
] as const;

export function ChannelScreen({
  session,
  channel,
  onBack,
  trailing,
  banner,
}: {
  session: SessionController;
  channel: string;
  onBack: (() => void) | null;
  /** Extra header control, used to keep Sign out reachable for a channel-scoped key. */
  trailing?: ReactNode;
  banner?: ReactNode;
}) {
  const controller = useChannel(session, channel);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        {onBack ? <Button label="Channels" variant="ghost" onPress={onBack} /> : null}
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          #{channel}
        </Text>
        {trailing}
      </View>
      {banner}
      <View style={styles.tabs}>
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </View>
      {controller ? (
        <ChannelBody
          key={channel}
          session={session}
          controller={controller}
          tab={tab}
          bottomInset={insets.bottom}
        />
      ) : (
        <EmptyState title="Opening channel…" />
      )}
    </KeyboardAvoidingView>
  );
}

function ChannelBody({
  session,
  controller,
  tab,
  bottomInset,
}: {
  session: SessionController;
  controller: NonNullable<ReturnType<typeof useChannel>>;
  tab: Tab;
  bottomInset: number;
}) {
  const state = useStore(controller.state);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [restored, setRestored] = useState<{ draft: Draft; n: number } | null>(null);
  const me = session.session.username;

  const receipts = useReceipts(session, controller.channel, state.messages.at(-1)?.id ?? 0);
  const byId = useMemo(() => new Map(state.messages.map((m) => [m.id, m])), [state.messages]);
  const newestFirst = useMemo(() => [...state.messages].reverse(), [state.messages]);
  const onEdit = useCallback(
    (draft: Draft) => {
      setReplyTo(draft.replyTo !== undefined ? (byId.get(draft.replyTo) ?? null) : null);
      setRestored((prev) => ({ draft, n: (prev?.n ?? 0) + 1 }));
    },
    [byId],
  );

  if (state.phase === "loading") return <EmptyState title="Loading messages…" />;
  if (state.phase === "error") {
    return (
      <EmptyState title="Could not load this channel" body={state.error ?? undefined}>
        <Button label="Try again" variant="primary" onPress={() => controller.refresh()} />
      </EmptyState>
    );
  }

  const banner =
    state.stale && state.error ? (
      <Banner tone="warning" action={{ label: "Retry", onPress: () => controller.refresh() }}>
        Showing what was loaded earlier. {state.error}
      </Banner>
    ) : null;

  if (tab === "search") {
    return <SearchView api={session.api} channel={controller.channel} me={me} />;
  }
  if (tab === "snapshot") {
    return (
      <View style={{ flex: 1 }}>
        {banner}
        <SnapshotView state={state} />
      </View>
    );
  }
  if (tab === "tasks") {
    return (
      <View style={{ flex: 1 }}>
        {banner}
        <TaskActivityView messages={state.messages} truncated={state.olderNotLoaded} />
      </View>
    );
  }

  const empty = state.messages.length === 0 && state.outbox.length === 0;
  return (
    <View style={{ flex: 1 }}>
      {banner}
      {empty ? (
        <EmptyState title="No messages yet" body="Say something to start the conversation." />
      ) : (
        <FlatList<Message>
          inverted
          data={newestFirst}
          keyExtractor={(m) => String(m.id)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListHeaderComponent={
            state.outbox.length ? (
              <View style={{ gap: spacing.sm, marginBottom: spacing.sm }}>
                {state.outbox.map((item) => (
                  <OutboxRow key={item.id} item={item} channel={controller} onEdit={onEdit} />
                ))}
              </View>
            ) : null
          }
          ListFooterComponent={
            state.olderNotLoaded ? (
              <Text style={styles.older}>Older messages are not loaded in this app.</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              own={item.username === me}
              quoted={item.replyTo !== undefined ? byId.get(item.replyTo) : undefined}
              selected={replyTo?.id === item.id}
              onReply={(m) => setReplyTo((current) => (current?.id === m.id ? null : m))}
              receipts={receiptLine(receipts, item)}
            />
          )}
        />
      )}
      <Composer
        channel={controller}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        bottomInset={bottomInset}
        restored={restored}
      />
    </View>
  );
}

/**
 * Processed-by receipts for the open channel (ADR 0040): loaded when a new message arrives and on
 * a timer, because a commit is not a channel event. A failed load keeps the last answer.
 */
function useReceipts(session: SessionController, channel: string, newest: number): Receipt[] {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: newest only triggers a reload.
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadReceipts(session.api, channel, controller.signal).then(setReceipts, () => {});
    void load();
    const timer = setInterval(load, RECEIPTS_EVERY_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [session, channel, newest]);
  // Another channel's receipts must never label this one's messages.
  useEffect(() => setReceipts([]), [channel]);
  return receipts;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: 20, fontWeight: "800", flex: 1 },
  tabs: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  older: { color: colors.muted, textAlign: "center", padding: spacing.md, fontSize: 13 },
});
