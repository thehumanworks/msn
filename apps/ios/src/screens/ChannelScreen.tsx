import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
  type ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Draft } from "../core/channelController.ts";
import type { SessionController } from "../core/sessionController.ts";
import {
  arrivedUnseen,
  firstUnseen,
  ParentLoader,
  threadRoots,
  threadRows,
  type ThreadRow,
} from "../core/threads.ts";
import { toggled } from "../core/fold.ts";
import { messageLink } from "../core/links.ts";
import { seenMark } from "../core/readMarks.ts";
import { loadReceipts, type Receipt, RECEIPTS_EVERY_MS, receiptLine } from "../core/receipts.ts";
import type { Message, ReactionKind } from "../core/types.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageRow } from "../components/MessageRow.tsx";
import { MutePanel, muteButtonLabel, useMutes } from "../components/MutePanel.tsx";
import { OutboxRow } from "../components/OutboxRow.tsx";
import { PinnedStrip } from "../components/PinnedStrip.tsx";
import { SearchView } from "../components/SearchView.tsx";
import { SnapshotView } from "../components/SnapshotView.tsx";
import { TaskActivityView } from "../components/TaskActivityView.tsx";
import { colors, spacing } from "../components/theme.ts";
import { Banner, Button, EmptyState, Field, Segmented, Text } from "../components/ui.tsx";
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
  archived = false,
  onSetArchived,
}: {
  session: SessionController;
  channel: string;
  onBack: (() => void) | null;
  /** Extra header control, used to keep Sign out reachable for a channel-scoped key. */
  trailing?: ReactNode;
  banner?: ReactNode;
  /** An archived board (ADR 0046) reads but takes no posts. */
  archived?: boolean;
  /** Archive or unarchive this board; resolves to an error to show, or null. Owner only. */
  onSetArchived?: (archived: boolean) => Promise<string | null>;
}) {
  const controller = useChannel(session, channel);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("chat");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const toggleArchived = async () => {
    if (!onSetArchived) return;
    setArchiving(true);
    setArchiveError(await onSetArchived(!archived));
    setArchiving(false);
  };
  const [mutes, setMutes] = useMutes(session, channel);
  const [muting, setMuting] = useState(false);
  useEffect(() => setMuting(false), [channel]);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        {onBack ? <Button label="Channels" variant="ghost" onPress={onBack} /> : null}
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          #{channel}
        </Text>
        {onSetArchived && session.owner ? (
          <Button
            label={archived ? "Unarchive" : "Archive"}
            variant="ghost"
            busy={archiving}
            onPress={() => void toggleArchived()}
          />
        ) : null}
        {session.owner ? (
          <Button
            label={muteButtonLabel(mutes, channel)}
            variant="ghost"
            accessibilityHint="Hold back this board's notifications for you"
            onPress={() => setMuting((open) => !open)}
          />
        ) : null}
        {trailing}
      </View>
      {banner}
      {archiveError ? <Banner tone="danger">{archiveError}</Banner> : null}
      {session.owner && muting ? (
        <MutePanel
          key={channel}
          session={session}
          channel={channel}
          mutes={mutes}
          onChange={(next) => {
            setMutes(next);
            setMuting(false);
          }}
        />
      ) : null}
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
          archived={archived}
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
  archived,
}: {
  session: SessionController;
  controller: NonNullable<ReturnType<typeof useChannel>>;
  tab: Tab;
  bottomInset: number;
  archived: boolean;
}) {
  const state = useStore(controller.state);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [restored, setRestored] = useState<{ draft: Draft; n: number } | null>(null);
  const me = session.session.username;

  const receipts = useReceipts(session, controller.channel, state.messages.at(-1)?.id ?? 0);
  const byId = useMemo(() => new Map(state.messages.map((m) => [m.id, m])), [state.messages]);
  // Reply threads (ADR 0041): folded by default; the list is inverted, so newest row first.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  // Someone else's replies that arrived into a folded thread after the first load.
  const [unseen, setUnseen] = useState<ReadonlySet<number>>(() => new Set());
  const known = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (state.phase !== "ready" && state.messages.length === 0) return;
    const ids = new Set(state.messages.map((m) => m.id));
    if (known.current) {
      const arrived = arrivedUnseen(known.current, state.messages, expanded, me);
      if (arrived.length) setUnseen((current) => new Set([...current, ...arrived]));
    }
    known.current = ids;
    // Only new messages matter here; `expanded` is read as it stands when they arrive.
  }, [state.messages]);
  const rows = useMemo(
    () => threadRows(state.messages, expanded, unseen).reverse(),
    [state.messages, expanded, unseen],
  );
  const open = useCallback(
    (root: number) => {
      setExpanded((current) => new Set([...current, root]));
      const roots = threadRoots(state.messages);
      setUnseen((current) => new Set([...current].filter((id) => roots.get(id) !== root)));
    },
    [state.messages],
  );
  const toggle = useCallback(
    (root: number) => {
      if (expanded.has(root))
        setExpanded((current) => new Set([...current].filter((id) => id !== root)));
      else open(root);
    },
    [expanded, open],
  );
  const pointer = useMemo(() => firstUnseen(state.messages, unseen), [state.messages, unseen]);
  // Long messages the reader opened with Show more or jumped to (ADR 0050). Display only.
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const toggleFold = useCallback((id: number) => setUnfolded((current) => toggled(current, id)), []);
  // Read marks (ADR 0045): what reaches the screen while the app is active counts as read.
  const markRead = useRef<(ids: number[]) => void>(() => {});
  markRead.current = (ids) => {
    if (!session.marks || session.state.get().kind === "paused") return;
    const seen = seenMark(ids, unseen);
    if (seen !== null) session.marks.advance(controller.channel, seen);
  };
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<ThreadRow>[] }) =>
    markRead.current(viewableItems.flatMap((token) => (token.item ? [token.item.message.id] : []))),
  ).current;
  const list = useRef<FlatList<ThreadRow>>(null);
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  useEffect(() => {
    if (scrollTo === null) return;
    const index = rows.findIndex((row) => row.message.id === scrollTo);
    setScrollTo(null);
    if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  }, [rows, scrollTo]);
  // Your reply folds into its thread; open it so the reply does not seem to vanish.
  const onSent = useCallback(
    (draft: Draft) => {
      if (draft.replyTo === undefined) return;
      const root = threadRoots(state.messages).get(draft.replyTo);
      if (root !== undefined) open(root);
    },
    [state.messages, open],
  );
  const loader = useMemo(() => new ParentLoader(session.api, controller.channel), [session, controller]);
  useEffect(() => () => loader.cancel(), [loader]);
  const parents = useStore(loader.state);
  // Message links (ADR 0042): the share sheet offers Copy, Messages, Mail and the rest.
  // Reactions (ADR 0047): a failure shows in a banner until the next reaction.
  const [reactError, setReactError] = useState<string | null>(null);
  const onReact = useCallback(
    (message: Message, kind: ReactionKind) => {
      void controller.react(message.id, kind).then(setReactError);
    },
    [controller],
  );
  // Edits (ADR 0052): one message at a time, in a panel where the composer was.
  const [editing, setEditing] = useState<Message | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const onEditMessage = useCallback((message: Message) => {
    setEditError(null);
    setEditing(message);
  }, []);
  const onShareLink = useCallback(
    (message: Message) => {
      const { origin, tenant } = session.session;
      const url = messageLink(origin, tenant, controller.channel, message.id);
      // iOS shares the URL itself; other platforms take it as text.
      void Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch(() => {});
    },
    [session, controller],
  );
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
    ) : editError ? (
      <Banner tone="danger" action={{ label: "Dismiss", onPress: () => setEditError(null) }}>
        Message not edited: {editError}
      </Banner>
    ) : reactError ? (
      <Banner tone="danger" action={{ label: "Dismiss", onPress: () => setReactError(null) }}>
        Reaction not changed: {reactError}
      </Banner>
    ) : null;

  if (tab === "search") {
    return <SearchView api={session.api} channel={controller.channel} me={me} onShareLink={onShareLink} />;
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
      <PinnedStrip pinned={state.pinned} />
      {empty ? (
        <EmptyState title="No messages yet" body="Say something to start the conversation." />
      ) : (
        <FlatList<ThreadRow>
          ref={list}
          inverted
          onScrollToIndexFailed={({ index }) =>
            list.current?.scrollToOffset({ offset: Math.max(0, index * 80), animated: true })
          }
          data={rows}
          onViewableItemsChanged={onViewableItemsChanged}
          keyExtractor={(row) => String(row.message.id)}
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
          renderItem={({ item: row }) => {
            const item = row.message;
            const parent = item.replyTo !== undefined && !byId.has(item.replyTo) ? parents.get(item.replyTo) : undefined;
            return (
              <MessageRow
                message={item}
                own={item.username === me}
                quoted={
                  item.replyTo === undefined
                    ? undefined
                    : (byId.get(item.replyTo) ??
                      (parent?.status === "loaded" ? (parent.message ?? undefined) : undefined))
                }
                parent={parent}
                onLoadParent={item.replyTo !== undefined && !byId.has(item.replyTo) ? (id) => void loader.load(id) : undefined}
                nested={row.kind === "reply"}
                thread={
                  row.kind === "message" && row.replies > 0
                    ? { replies: row.replies, open: row.open, unseen: row.unseen }
                    : undefined
                }
                onToggleThread={toggle}
                selected={replyTo?.id === item.id}
                onReply={(m) => setReplyTo((current) => (current?.id === m.id ? null : m))}
                receipts={receiptLine(receipts, item)}
                onShareLink={onShareLink}
                onToggleFold={toggleFold}
                unfolded={unfolded.has(item.id)}
                me={me}
                onReact={archived ? undefined : onReact}
                onEditMessage={!archived && item.username === me && me !== "github" ? onEditMessage : undefined}
              />
            );
          }}
        />
      )}
      {pointer ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens the thread and scrolls to the reply"
          onPress={() => {
            open(pointer.root);
            setUnfolded((current) => new Set([...current, pointer.id]));
            setScrollTo(pointer.id);
          }}
          style={styles.pointer}
        >
          <Text style={styles.pointerText}>New reply in thread #{pointer.root} · Show</Text>
        </Pressable>
      ) : null}
      {archived ? (
        <View style={[styles.archived, { paddingBottom: bottomInset + spacing.md }]}>
          <Text style={styles.archivedText}>Archived · this board is read only. Unarchive it to post again.</Text>
        </View>
      ) : editing ? (
        <EditPanel
          key={editing.id}
          message={editing}
          bottomInset={bottomInset}
          onCancel={() => setEditing(null)}
          onSave={async (text) => {
            const error = await controller.editMessage(editing.id, text);
            setEditError(error);
            if (!error) setEditing(null);
          }}
        />
      ) : (
        <Composer
          channel={controller}
          onSent={onSent}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          bottomInset={bottomInset}
          restored={restored}
        />
      )}
    </View>
  );
}

/** Edits one of your messages (ADR 0052): the text, then Save or Cancel. */
function EditPanel({
  message,
  bottomInset,
  onCancel,
  onSave,
}: {
  message: Message;
  bottomInset: number;
  onCancel: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(message.text);
  const [busy, setBusy] = useState(false);
  return (
    <View style={[styles.editPanel, { paddingBottom: bottomInset + spacing.md }]}>
      <Field
        label={`Edit message #${message.id}`}
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        autoCapitalize="sentences"
        autoCorrect
        style={styles.editInput}
      />
      <View style={styles.editActions}>
        <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={busy} />
        <Button
          label="Save"
          variant="primary"
          busy={busy}
          disabled={!text.trim()}
          onPress={() => {
            setBusy(true);
            void onSave(text).finally(() => setBusy(false));
          }}
        />
      </View>
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
  pointer: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pointerText: { color: colors.accent, fontWeight: "600", fontSize: 14 },
  archived: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  archivedText: { color: colors.muted, fontSize: 14 },
  editPanel: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  editInput: { minHeight: 80, maxHeight: 200, textAlignVertical: "top" },
  editActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
