import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { AgentRegistration } from "../components/AgentRegistration.tsx";
import { Action, Card, Note } from "../components/Form.tsx";
import { GlassButton, Surface } from "../components/Glass.tsx";
import { openAgentConnectors, useArchived } from "../lib/boardActions.ts";
import { type AgentPersona, explain, type Webhook, webhookSummary } from "../lib/manage.ts";
import { manageFor, useSession } from "../lib/model.ts";
import { useStore } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** Null means a plain channel. An empty array is already a board and needs no new credential. */
  | { kind: "ready"; personas: AgentPersona[] | null; hooks: Map<string, Webhook> };

export default function Agents() {
  const { board } = useLocalSearchParams<{ board: string }>();
  return <Roster key={board} board={board} />;
}

function Roster({ board }: { board: string }) {
  const session = useSession();
  const ready = useStore(session.state).ready;
  const owner = ready && session.owner;
  const archived = useArchived(board);
  const canWrite = ready && !session.watchOnly && !archived;
  const manage = useMemo(() => manageFor(session), [session]);
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const view = useRef<AbortController | null>(null);
  const read = useRef(0);

  const load = useCallback(async () => {
    const signal = view.current?.signal;
    if (!ready || !signal || signal.aborted) return;
    const request = ++read.current;
    try {
      const personas = await manage.personas(board, signal);
      // Members can read the roster, not the owner's webhook settings.
      const hooks = owner && personas?.length ? await manage.webhooks(board, signal) : new Map<string, Webhook>();
      if (!signal.aborted && request === read.current) setState({ kind: "ready", personas, hooks });
    } catch (caught) {
      if (signal.aborted || request !== read.current) return;
      const told = explain(caught, "show agents");
      if (told.expired) session.reportAuthFailure();
      setState({ kind: "error", message: told.message });
    }
  }, [manage, board, owner, ready, session]);

  useFocusEffect(useCallback(() => {
    const stop = new AbortController();
    view.current = stop;
    void load();
    return () => { stop.abort(); view.current = null; };
  }, [load]));

  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <Stack.Screen options={{ title: "Agents", headerLargeTitleEnabled: false }} />
      {owner && !session.watchOnly && !session.session.channel ? <>
        <Card><Action last label="Agent connectors" onPress={() => openAgentConnectors(board)} /></Card>
        <Note>Use Agent connectors for a persistent user and an installation key. The board names and webhooks below do not grant separate access.</Note>
      </> : null}
      {state.kind === "loading" ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}

      {state.kind === "error" ? (
        <View style={styles.empty}>
          <SymbolView name="exclamationmark.triangle" tintColor={color.secondary} size={40} />
          <Text style={styles.emptyText}>{state.message}</Text>
          <GlassButton label="Try again" tint={color.tint} onPress={() => void load()} />
        </View>
      ) : null}

      {state.kind === "ready" ? (
        <>
          {canWrite && (state.personas !== null || owner) ? (
            <AgentRegistration key={state.personas === null ? "setup" : "register"}
              board={board} plain={state.personas === null} manage={manage} reload={load} />
          ) : (
            <Note>{archived ? "This board is archived and read-only." : session.watchOnly
              ? "Your access is watch only." : "Only the workspace owner can enable agents on this channel."}</Note>
          )}
          {!state.personas?.length ? (
            <View style={styles.empty}>
              <SymbolView name="person.2" tintColor={color.tertiary} size={44} />
              <Text style={styles.emptyTitle}>No agents registered yet</Text>
            </View>
          ) : (
            <>
              {owner && canWrite ? <Note>Select an agent to add, test or change its webhook.</Note> : null}
              {state.personas.map((persona) => {
                const hook = state.hooks.get(persona.id) ?? null;
                const editable = owner && canWrite;
                const summary = owner ? webhookSummary(hook) : persona.listening ? "Listening" : "Not listening";
                return (
                  <Pressable
                    key={persona.id}
                    disabled={!editable}
                    onPress={() => router.push({
                      pathname: "/webhook", params: { board, persona: persona.id, name: persona.displayName },
                    })}
                    style={({ pressed }) => pressed && { opacity: 0.6 }}
                    accessibilityRole={editable ? "button" : "text"}
                    accessibilityLabel={`${persona.displayName}. ${summary}`}
                    accessibilityHint={editable ? (hook ? "Opens its webhook" : "Adds a webhook") : undefined}
                  >
                    <Surface style={styles.row}>
                      <View style={[styles.dot, { backgroundColor: persona.listening ? color.success : color.fill }]} />
                      <View style={{ flex: 1, gap: 3 }}>
                        <Text style={styles.name}>{persona.displayName}</Text>
                        <Text style={styles.summary}>{summary}</Text>
                        {hook?.pending ? (
                          <Text style={styles.summary}>{hook.pending} {hook.pending === 1 ? "notice" : "notices"} waiting</Text>
                        ) : null}
                      </View>
                      {editable ? <SymbolView name={hook ? "bolt.fill" : "plus.circle"} tintColor={color.tint} size={20} /> : null}
                    </Surface>
                  </Pressable>
                );
              })}
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 60, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 22 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 17, fontWeight: "600", color: color.label },
  summary: { fontSize: 13, lineHeight: 17, color: color.secondary },
  empty: { alignItems: "center", gap: 12, marginTop: 40, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: color.label, textAlign: "center" },
  emptyText: { fontSize: 15, lineHeight: 20, color: color.secondary, textAlign: "center" },
});
