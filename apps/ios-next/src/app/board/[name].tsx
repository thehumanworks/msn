import { useHeaderHeight } from "expo-router/react-navigation";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  type TextInputInstance,
  View,
  type ListViewToken,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { addressees } from "../../../../ios/src/core/address.ts";
import { ApiError } from "../../../../ios/src/core/errors.ts";
import type { Persona } from "../../../../ios/src/core/mention.ts";
import { Composer } from "../../components/Composer.tsx";
import { ConnectionPill } from "../../components/ConnectionPill.tsx";
import { Surface } from "../../components/Glass.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import {
  MessageBubble,
  OutboxBubble,
  type Row,
} from "../../components/MessageBubble.tsx";
import { deleteBoard, openAgentConnectors, openAgents, openInvite, setArchived, useArchived } from "../../lib/boardActions.ts";
import { emptyDraft, type MentionDraft } from "../../lib/mentionDraft.ts";
import { useSession } from "../../lib/model.ts";
import {
  type ChannelController,
  type Message,
  messageLink,
  type OutboxItem,
  seenMark,
  useChannel,
  useStore,
} from "../../lib/shared.ts";
import { color } from "../../lib/theme.ts";

const GROUP_MS = 5 * 60 * 1000;

export default function Board() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const session = useSession();
  const controller = useChannel(session, name);
  const archived = useArchived(name);
  const owner = session.owner;
  return (
    <>
      {/* An opaque bar: iOS 26's scroll edge effect under a transparent bar blurs all of an inverted list. */}
      <Stack.Screen options={{ title: `# ${name}`, headerTransparent: false }} />
      {/* Nobody can join an archived board, and a member who is not the owner has nothing else here. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Board actions" hidden={archived && !owner}>
          <Stack.Toolbar.MenuAction icon="person.badge.plus" hidden={archived} onPress={() => openInvite(name)}>
            Invite people
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="person.crop.circle.badge.plus" hidden={!owner || session.watchOnly || Boolean(session.session.channel)} onPress={() => openAgentConnectors(name)}>
            Agent connectors
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="bolt" hidden={archived} onPress={() => openAgents(name)}>
            {owner ? "Agents and webhooks" : "Agents"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon={archived ? "tray.and.arrow.up" : "archivebox"}
            hidden={!owner}
            onPress={() => setArchived(session, name, !archived)}
          >
            {archived ? "Unarchive" : "Archive"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="trash"
            destructive
            hidden={!owner}
            onPress={() => deleteBoard(session, name, () => router.back())}
          >
            Delete board…
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {controller?.channel === name ? (
        <Conversation key={name} controller={controller} archived={archived} owner={owner} />
      ) : (
        <ActivityIndicator
          style={{ flex: 1 }}
        />
      )}
    </>
  );
}

function Conversation({
  controller,
  archived,
  owner,
}: {
  controller: ChannelController;
  archived: boolean;
  owner: boolean;
}) {
  const session = useSession();
  const state = useStore(controller.state);
  const me = session.session.username;
  const headerHeight = useHeaderHeight();
  const ready = useStore(session.state).ready;
  const readOnly = archived
    ? owner ? "This board is archived and read-only. Unarchive it from the menu above to post again."
      : "This board is archived and read-only."
    : !ready ? "Checking board access…" : session.watchOnly ? "Your access is watch only." : null;
  const [draft, setDraft] = useState(emptyDraft);
  // The outbox's Edit action checks the current text before replacing the draft.
  const typed = useRef("");
  const changeDraft = useCallback((next: MentionDraft) => { typed.current = next.text; setDraft(next); }, []);
  const roster = useRef<Promise<Persona[]> | null>(null);
  // A return from Agents may have new names. Do not query until the next @.
  useFocusEffect(useCallback(() => () => { roster.current = null; }, []));
  const loadPersonas = useCallback(() => {
    if (roster.current) return roster.current;
    const request: Promise<Persona[]> = session.api.listPersonas(controller.channel, session.signal).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "board_not_found") return [];
      if (roster.current === request) roster.current = null;
      if (error instanceof ApiError && error.isAuthExpired) session.reportAuthFailure();
      throw error;
    });
    roster.current = request;
    return request;
  }, [controller, session]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusHeight, setStatusHeight] = useState(0);
  // The inverted list's bottom padding is its visual top, below the floating status chips.
  const topInset = state.statuses.length ? statusHeight : 0;
  const input = useRef<TextInputInstance>(null);
  const list = useRef<FlatList<Row>>(null);

  // Newest first: the list is inverted so it opens at the latest message.
  const rows = useMemo<Row[]>(() => {
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    const out: Row[] = state.outbox
      .map((item) => ({ kind: "outbox" as const, item }))
      .reverse();
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i] as Message;
      const previous = state.messages[i - 1];
      const grouped =
        previous &&
        previous.username === message.username &&
        !message.replyTo &&
        Date.parse(message.createdAt) - Date.parse(previous.createdAt) <
          GROUP_MS;
      out.push({
        kind: "message",
        message,
        mine: message.username === me && !message.agentUserId,
        showName: !grouped,
        replied: message.replyTo ? (byId.get(message.replyTo) ?? null) : null,
        me,
      });
    }
    return out;
  }, [state.messages, state.outbox, me]);

  // Read marks (ADR 0045): what is on screen while the app is active counts as read.
  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ListViewToken[] }) => {
      if (!session.marks || session.state.get().kind === "paused") return;
      const ids = viewableItems.flatMap((token) =>
        (token.item as Row | undefined)?.kind === "message"
          ? [(token.item as Extract<Row, { kind: "message" }>).message.id]
          : [],
      );
      const seen = seenMark(ids, []);
      if (seen !== null) session.marks.advance(controller.channel, seen);
      controller.noteSeen(ids);
    },
    [controller, session],
  );

  const send = useCallback(() => {
    if (readOnly) return;
    const result = controller.send({
      ...draft,
      ...(replyTo ? { replyTo: replyTo.id } : {}),
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    changeDraft(emptyDraft);
    setReplyTo(null);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  }, [controller, draft, replyTo, readOnly, changeDraft]);

  const onLongPress = useCallback(
    (message: Message) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: message.username,
          options: ["Reply", "Copy text", "Copy link", "Cancel"],
          cancelButtonIndex: 3,
        },
        (index) => {
          if (index === 0) {
            setReplyTo(message);
            input.current?.focus();
          }
          if (index === 1) void Clipboard.setStringAsync(message.text);
          if (index === 2) {
            const { origin, tenant } = session.session;
            void Clipboard.setStringAsync(
              messageLink(origin, tenant, controller.channel, message.id),
            );
          }
        },
      );
    },
    [controller, session],
  );

  const onAnswer = useCallback(
    (message: Message, choice: string) => {
      void controller.answer(message.id, choice).then((failure) => {
        if (failure) Alert.alert("Could not answer", failure);
      });
    },
    [controller],
  );

  const onOutbox = useCallback(
    (item: OutboxItem) => {
      const retry = item.status === "uncertain";
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: item.error ?? undefined,
          options: [retry ? "Retry" : "Edit", "Discard", "Cancel"],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0 && retry) controller.retrySend(item.id);
          if (index === 0 && !retry) {
            const edit = () => {
              const draft = controller.takeRejected(item.id);
              if (draft) {
                changeDraft({ text: draft.text, recipients: addressees(draft) });
                setReplyTo(state.messages.find((message) => message.id === draft.replyTo) ?? null);
              }
            };
            // Never drop what is in the composer without asking.
            if (!typed.current.trim()) edit();
            else
              Alert.alert("Replace your draft?", "Editing the failed message replaces what you have typed.", [
                { text: "Cancel", style: "cancel" },
                { text: "Replace", style: "destructive", onPress: edit },
              ]);
          }
          if (index === 1) controller.discardSend(item.id);
        },
      );
    },
    [controller, changeDraft, state.messages],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) =>
      item.kind === "message" ? (
        <MessageBubble
          row={item}
          onLongPress={onLongPress}
          onAnswer={onAnswer}
          origin={session.session.origin}
        />
      ) : (
        <OutboxBubble item={item.item} onPress={onOutbox} />
      ),
    [onLongPress, onAnswer, onOutbox],
  );

  const header = (
    // Rendered at the top of the inverted list: the oldest end of the conversation.
    <View style={{ gap: 10, paddingTop: 8, paddingBottom: 12 }}>
      {state.olderNotLoaded ? (
        <Text style={styles.older}>
          Older messages are on the web app and in the msn CLI.
        </Text>
      ) : null}
      {state.brief ? (
        <Surface style={styles.brief}>
          <Text style={styles.briefTitle}>Brief</Text>
          <Markdown
            text={state.brief.text}
            color={color.label}
            tint={color.tint}
          />
        </Surface>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={["bottom"]} style={styles.fill}>
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
        style={styles.fill}
      >
        <View style={styles.fill}>
          {state.phase === "loading" && !state.messages.length ? (
            <ActivityIndicator style={{ flex: 1 }} />
          ) : (
            <FlatList
              ref={list}
              data={rows}
              inverted
              keyExtractor={(row) =>
                row.kind === "message" ? `m${row.message.id}` : `o${row.item.id}`
              }
              renderItem={renderItem}
              onViewableItemsChanged={onViewable}
              viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentInsetAdjustmentBehavior="never"
              contentContainerStyle={[
                styles.content,
                { paddingBottom: topInset },
              ]}
              ListFooterComponent={header}
              ListEmptyComponent={
                <Text style={[styles.older, { transform: [{ scaleY: -1 }] }]}>
                  {state.error ?? "No messages yet. Say hello."}
                </Text>
              }
            />
          )}
          <ConnectionPill bottom={0} />
        </View>
        {/* Keep the composer in normal flow so it moves with the keyboard padding. */}
        <View style={styles.composer}>
          <Composer
            ref={input}
            draft={draft}
            onDraftChange={changeDraft}
            messages={state.messages}
            me={me}
            loadPersonas={loadPersonas}
            onSend={send}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            readOnly={readOnly}
            error={
              error ??
              (state.error && state.messages.length ? state.error : null)
            }
          />
        </View>
      </KeyboardAvoidingView>
      {state.statuses.length ? (
        <View
          style={styles.statusBar}
          pointerEvents="box-none"
          onLayout={(event: LayoutChangeEvent) =>
            setStatusHeight(event.nativeEvent.layout.height)
          }
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={styles.statuses}
          >
            {state.statuses.map((status) => (
              <Surface key={status.name} strength="chip" style={styles.status}>
                <View style={styles.dot} />
                <Text style={styles.statusText} numberOfLines={1}>
                  <Text style={{ fontWeight: "700" }}>{status.name}</Text>{" "}
                  {status.text}
                </Text>
              </Surface>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 12, paddingTop: 12 },
  composer: { paddingHorizontal: 12, paddingVertical: 8 },
  older: {
    textAlign: "center",
    fontSize: 13,
    color: color.secondary,
    padding: 12,
  },
  brief: { borderRadius: 22, padding: 14, gap: 6 },
  briefTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: color.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statusBar: { position: "absolute", top: 0, left: 0, right: 0 },
  statuses: {
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 260,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.success },
  statusText: { fontSize: 13, color: color.label, flexShrink: 1 },
});
