import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ConnectionPill } from "../components/ConnectionPill.tsx";
import { Glass, GlassButton, Surface } from "../components/Glass.tsx";
import { deleteBoard, openAgents, openInvite, setArchived } from "../lib/boardActions.ts";
import { boardList, model, pending, useSession } from "../lib/model.ts";
import { type ChannelSummary, currentUnread, unreadBadge, useChannelList, useStore } from "../lib/shared.ts";
import { color, shortTime } from "../lib/theme.ts";

export default function Boards() {
  const session = useSession();
  const connection = useStore(session.state);
  if (!connection.ready) return <Connecting />;
  return <BoardList />;
}

function Connecting() {
  const session = useSession();
  const state = useStore(session.state);
  const failed = state.kind === "failed" || state.kind === "expired";
  return (
    <View style={styles.center}>
      <Stack.Screen
        options={{
          title: session.session.tenant,
          headerLargeTitleEnabled: false,
        }}
      />
      {failed ? (
        <SymbolView name="wifi.exclamationmark" tintColor={color.secondary} size={44} />
      ) : (
        <ActivityIndicator size="large" />
      )}
      <Text style={styles.centerTitle}>
        {failed ? "Could not connect" : `Connecting to ${session.session.tenant}…`}
      </Text>
      {state.message ? <Text style={styles.centerText}>{state.message}</Text> : null}
      <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
        {failed && state.retryable ? (
          <GlassButton label="Retry" tint={color.tint} onPress={() => session.retry()} />
        ) : null}
        <GlassButton
          label="Sign out"
          textColor={color.label as unknown as string}
          onPress={() => void model.signOut()}
        />
      </View>
    </View>
  );
}

function BoardList() {
  const session = useSession();
  const list = useChannelList(session);
  const empty = useMemo(
    () => ({
      phase: "loading" as const,
      channels: [],
      error: null,
      unread: new Map(),
    }),
    [],
  );
  const state = useStore(list?.state ?? emptyStore(empty));
  const marks = useStore(list?.marks ?? emptyStore([] as const));
  const [query, setQuery] = useState("");
  // Archived boards (ADR 0046) stay out of the list unless the person asks to see them.
  const [showArchived, setShowArchived] = useState(false);
  const scoped = session.session.channel;

  // A board's own screen reads and changes the same list (archive, delete).
  useEffect(() => {
    boardList.set(list);
    return () => {
      if (boardList.get() === list) boardList.set(null);
    };
  }, [list]);

  // A board link names its board: open it once the session can read.
  useEffect(() => {
    const board = pending.board;
    if (board) {
      pending.board = null;
      router.push({ pathname: "/board/[name]", params: { name: board } });
    }
  }, []);

  const boards = useMemo(() => {
    const words = query.trim().toLowerCase();
    return state.channels
      .filter((board) => showArchived || !board.archivedAt)
      .filter((board) => !words || board.name.includes(words))
      .sort(
        (a, b) =>
          // Archived boards sit below the active ones.
          Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) ||
          (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt),
      );
  }, [state.channels, query, showArchived]);
  const archivedCount = useMemo(() => state.channels.filter((board) => board.archivedAt).length, [state.channels]);
  // With the last archived board gone the toggle is hidden, so it must not stay on: the next board
  // to be archived has to leave the list.
  if (showArchived && !archivedCount) setShowArchived(false);

  /** A long press on a board: what this person may do with it. */
  function boardMenu(board: ChannelSummary) {
    const archived = Boolean(board.archivedAt);
    const actions: { label: string; run: () => void; destructive?: boolean }[] = [];
    // Nobody can join an archived board, so there is nothing to invite to.
    if (!archived) actions.push({ label: "Invite people", run: () => openInvite(board.name) });
    if (session.owner) {
      if (!archived) actions.push({ label: "Agents and webhooks", run: () => openAgents(board.name) });
      actions.push({
        label: archived ? "Unarchive" : "Archive",
        run: () => setArchived(session, board.name, !archived),
      });
      actions.push({ label: "Delete board…", destructive: true, run: () => deleteBoard(session, board.name) });
    }
    if (!actions.length) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: `# ${board.name}${archived ? " · archived" : ""}`,
        options: [...actions.map((action) => action.label), "Cancel"],
        // The owner's list ends with Delete; everyone else has no destructive action.
        ...(actions.at(-1)?.destructive ? { destructiveButtonIndex: actions.length - 1 } : {}),
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.run(),
    );
  }

  function newBoard() {
    Alert.prompt("New board", "Lowercase letters, digits, - and _.", async (name) => {
      if (!list || !name?.trim()) return;
      const error = await list.create(name.trim().toLowerCase());
      if (error) Alert.alert("Could not create the board", error);
      else
        router.push({
          pathname: "/board/[name]",
          params: { name: name.trim().toLowerCase() },
        });
    });
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: scoped ? "Board" : session.session.tenant,
          headerLargeTitleEnabled: true,
          headerSearchBarOptions: {
            placeholder: "Find a board",
            onChangeText: (event) => setQuery(event.nativeEvent.text),
          },
        }}
      />
      <Stack.Toolbar placement="right">
        {!scoped ? <Stack.Toolbar.Button icon="plus" accessibilityLabel="New board" onPress={newBoard} /> : null}
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More" hidden={Boolean(scoped) && !archivedCount}>
          <Stack.Toolbar.MenuAction icon="person.badge.plus" hidden={Boolean(scoped)} onPress={() => openInvite(null)}>
            Invite to workspace
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="archivebox"
            hidden={!archivedCount}
            isOn={showArchived}
            onPress={() => setShowArchived((shown) => !shown)}
          >
            {`Show archived (${archivedCount})`}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon="person.crop.circle"
          accessibilityLabel="Account"
          onPress={() => router.push("/account")}
        />
      </Stack.Toolbar>
      <FlatList
        data={boards}
        keyExtractor={(board) => board.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void list?.load()} />}
        renderItem={({ item }) => (
          <BoardRow
            board={item}
            badge={unreadBadge(currentUnread(state.unread, marks, item.name))}
            onLongPress={boardMenu}
          />
        )}
        ListEmptyComponent={
          state.phase === "loading" ? (
            <ActivityIndicator style={{ marginTop: 40 }} />
          ) : (
            <View style={styles.empty}>
              <SymbolView name="bubble.left.and.bubble.right" tintColor={color.tertiary} size={48} />
              <Text style={styles.centerTitle}>{state.error ?? (query ? "No board matches" : "No boards yet")}</Text>
              {!query && !state.error ? (
                <Text style={styles.centerText}>Create one with + or from the msn CLI.</Text>
              ) : null}
            </View>
          )
        }
      />
      <ConnectionPill />
    </>
  );
}

function BoardRow({
  board,
  badge,
  onLongPress,
}: {
  board: ChannelSummary;
  badge: ReturnType<typeof unreadBadge>;
  onLongPress: (board: ChannelSummary) => void;
}) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/board/[name]", params: { name: board.name } })}
      onLongPress={() => onLongPress(board)}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
      accessibilityRole="button"
      accessibilityLabel={`${board.name}${board.archivedAt ? ", archived" : ""}${badge ? `, ${badge.label}` : ""}`}
      accessibilityHint="Long press for more"
    >
      <Surface style={styles.row}>
        <View style={styles.hash}>
          <Text style={[styles.hashText, board.archivedAt && { color: color.secondary }]}>#</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.name, badge && { fontWeight: "700" }]} numberOfLines={1}>
            {board.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {board.messageCount} {board.messageCount === 1 ? "message" : "messages"} · {board.participantCount}{" "}
            {board.participantCount === 1 ? "member" : "members"}
            {board.archivedAt ? " · archived" : ""}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <Text style={styles.time}>{shortTime(board.lastActivityAt)}</Text>
          {badge ? (
            <Glass tintColor={badge.toYou ? "#ff3b30" : "#0a84ff"} style={styles.badge}>
              <Text style={styles.badgeText}>{badge.toYou ?? badge.count}</Text>
            </Glass>
          ) : null}
        </View>
      </Surface>
    </Pressable>
  );
}

// A stand-in store until the list controller exists (it is created in an effect).
const stand = new WeakMap<object, { get: () => unknown; subscribe: (fn: () => void) => () => void }>();
function emptyStore<T extends object>(value: T) {
  let store = stand.get(value);
  if (!store) {
    store = { get: () => value, subscribe: () => () => {} };
    stand.set(value, store);
  }
  return store as unknown as Parameters<typeof useStore<T>>[0];
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 32,
  },
  centerTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: color.label,
    textAlign: "center",
  },
  centerText: { fontSize: 15, color: color.secondary, textAlign: "center" },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 120, gap: 10 },
  empty: { alignItems: "center", gap: 10, marginTop: 80 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 22,
  },
  hash: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: color.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  hashText: { fontSize: 20, fontWeight: "700", color: color.tint },
  name: { fontSize: 17, fontWeight: "600", color: color.label },
  meta: { fontSize: 13, color: color.secondary },
  time: { fontSize: 13, color: color.secondary },
  badge: {
    minWidth: 26,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 13, fontWeight: "700", color: "#fff" },
});
