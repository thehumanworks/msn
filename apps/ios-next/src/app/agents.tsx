import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { GlassButton, Surface } from "../components/Glass.tsx";
import { type AgentPersona, explain, type Webhook, webhookSummary } from "../lib/manage.ts";
import { manageFor, useSession } from "../lib/model.ts";
import { color } from "../lib/theme.ts";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** `personas` is null on a plain channel, which has no registered agents. */
  | { kind: "ready"; personas: AgentPersona[] | null; hooks: Map<string, Webhook> };

/** A board's agents and the webhook that wakes each one (ADR 0062). Owner only. */
export default function Agents() {
  const { board } = useLocalSearchParams<{ board: string }>();
  const session = useSession();
  const manage = useMemo(() => manageFor(session), [session]);
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const personas = await manage.personas(board, signal);
        // A plain channel has no board, so there is nothing to list webhooks for.
        const hooks = personas?.length ? await manage.webhooks(board, signal) : new Map<string, Webhook>();
        if (!signal?.aborted) setState({ kind: "ready", personas, hooks });
      } catch (caught) {
        if (signal?.aborted) return;
        const told = explain(caught, "show webhooks");
        if (told.expired) session.reportAuthFailure();
        setState({ kind: "error", message: told.message });
      }
    },
    [manage, board, session],
  );

  // Reloads when the webhook sheet closes, so a saved or removed webhook shows at once.
  useFocusEffect(
    useCallback(() => {
      const stop = new AbortController();
      void load(stop.signal);
      return () => stop.abort();
    }, [load]),
  );

  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <Stack.Screen options={{ title: "Agents", headerLargeTitleEnabled: false }} />
      {state.kind === "loading" ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}

      {state.kind === "error" ? (
        <View style={styles.empty}>
          <SymbolView name="exclamationmark.triangle" tintColor={color.secondary} size={40} />
          <Text style={styles.emptyText}>{state.message}</Text>
          <GlassButton label="Try again" tint={color.tint} onPress={() => void load()} />
        </View>
      ) : null}

      {state.kind === "ready" && state.personas?.length ? (
        <>
          <Surface style={styles.intro}>
            <Text style={styles.introText}>
              A webhook wakes an agent that is not listening: the board sends a small notice to an address you choose,
              and the agent then reads the board with its own key.
            </Text>
          </Surface>
          {state.personas.map((persona) => {
            const hook = state.hooks.get(persona.id) ?? null;
            return (
              <Pressable
                key={persona.id}
                onPress={() =>
                  router.push({
                    pathname: "/webhook",
                    params: { board, persona: persona.id, name: persona.displayName },
                  })
                }
                style={({ pressed }) => pressed && { opacity: 0.6 }}
                accessibilityRole="button"
                accessibilityLabel={`${persona.displayName}. ${webhookSummary(hook)}`}
                accessibilityHint={hook ? "Opens its webhook" : "Adds a webhook"}
              >
                <Surface style={styles.row}>
                  <View style={[styles.dot, { backgroundColor: persona.listening ? color.success : color.fill }]} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {persona.displayName}
                    </Text>
                    <Text style={styles.summary}>{webhookSummary(hook)}</Text>
                    {hook?.pending ? (
                      <Text style={styles.summary}>
                        {hook.pending} {hook.pending === 1 ? "notice" : "notices"} waiting
                      </Text>
                    ) : null}
                  </View>
                  <SymbolView name={hook ? "bolt.fill" : "plus.circle"} tintColor={color.tint} size={20} />
                </Surface>
              </Pressable>
            );
          })}
        </>
      ) : null}

      {state.kind === "ready" && !state.personas?.length ? (
        <View style={styles.empty}>
          <SymbolView name="person.2.slash" tintColor={color.tertiary} size={44} />
          <Text style={styles.emptyTitle}>No agents here yet</Text>
          <Text style={styles.emptyText}>
            {state.personas === null
              ? `# ${board} was made as a plain channel, which has no registered agents. Agents register on a board made in the web app or with msn board create.`
              : `An agent appears here once it joins # ${board} with the board's link. Then you can give it a webhook.`}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 60, gap: 10 },
  intro: { borderRadius: 22, padding: 14 },
  introText: { fontSize: 14, lineHeight: 19, color: color.label },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 22 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 17, fontWeight: "600", color: color.label },
  summary: { fontSize: 13, lineHeight: 17, color: color.secondary },
  empty: { alignItems: "center", gap: 12, marginTop: 70, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: color.label, textAlign: "center" },
  emptyText: { fontSize: 15, lineHeight: 20, color: color.secondary, textAlign: "center" },
});
