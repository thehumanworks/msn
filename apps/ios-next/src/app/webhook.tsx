import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet } from "react-native";
import { Action, Card, Choice, Field, Heading, Note } from "../components/Form.tsx";
import {
  authText,
  checkBearer,
  checkWebhookUrl,
  explain,
  SUBSCRIBE_LABEL,
  type Subscription,
  SUBSCRIPTIONS,
  subscribeNote,
  WAKE_FORMATS,
  WAKE_LABEL,
  type WakeFormat,
  type Webhook,
  webhookSummary,
} from "../lib/manage.ts";
import { manageFor, useSession } from "../lib/model.ts";
import { color } from "../lib/theme.ts";

/** How long a test notice usually takes to be sent, before its outcome is read back. */
const TEST_SETTLE_MS = 2500;

/** Set, test or remove the webhook that wakes one agent (ADR 0062, ADR 0076). Owner only. */
export default function WebhookSheet() {
  const { board, persona, name } = useLocalSearchParams<{ board: string; persona: string; name?: string }>();
  const session = useSession();
  const manage = useMemo(() => manageFor(session), [session]);
  const [hook, setHook] = useState<Webhook | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [format, setFormat] = useState<WakeFormat>("notice");
  const [subscribe, setSubscribe] = useState<Subscription>("addressed");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [status, setStatus] = useState<{ text: string; failed?: boolean } | null>(null);
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  const fail = (caught: unknown) => {
    const told = explain(caught, "set webhooks");
    if (told.expired) session.reportAuthFailure();
    if (open.current) setStatus({ text: told.message, failed: true });
  };

  useEffect(() => {
    let current = true;
    manage
      .webhook(board, persona)
      .then((found) => {
        if (!current) return;
        setHook(found);
        if (found) {
          setUrl(found.url);
          setSubscribe(found.subscribe);
          setFormat(found.format ?? "notice");
        }
      })
      .catch((caught) => current && fail(caught))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [manage, board, persona]);

  async function save() {
    setBusy("save");
    setStatus(null);
    try {
      const key = bearer.trim();
      const made = await manage.setWebhook(board, persona, {
        url: url.trim(),
        subscribe, format,
        ...(key ? { bearer: key } : {}),
      });
      if (!open.current) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setHook(made);
      // The key is never shown again; clear it so it does not sit in the field.
      setBearer("");
      setStatus({ text: `Saved. ${authText(made)}` });
    } catch (caught) {
      fail(caught);
    } finally {
      if (open.current) setBusy(null);
    }
  }

  function submit() {
    const problem = checkWebhookUrl(url) ?? checkBearer(bearer);
    if (problem) return setStatus({ text: problem, failed: true });
    if (format === "claude-routine" && !bearer.trim())
      return setStatus({ text: "Enter the Claude task’s trigger bearer key, not an MSN key.", failed: true });
    // A save replaces the whole webhook (ADR 0062), so an empty key field removes a saved key.
    if (hook?.bearer && !bearer.trim())
      return Alert.alert(
        "Remove the bearer key?",
        "Saving replaces the whole webhook. The saved key is not shown here, so leaving the field empty sends notices without a key. Enter the key again to keep it.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save without a key", style: "destructive", onPress: () => void save() },
        ],
      );
    void save();
  }

  async function test() {
    setBusy("test");
    setStatus(null);
    try {
      await manage.testWebhook(board, persona);
      if (!open.current) return;
      setStatus({ text: "Test notice queued. Checking how it went…" });
      await new Promise((resolve) => setTimeout(resolve, TEST_SETTLE_MS));
      const after = await manage.webhook(board, persona);
      if (!open.current) return;
      setHook(after);
      setStatus(after ? { text: webhookSummary(after), failed: after.lastDelivery?.status === "failed" } : null);
    } catch (caught) {
      fail(caught);
    } finally {
      if (open.current) setBusy(null);
    }
  }

  function remove() {
    Alert.alert(`Remove the webhook for ${name ?? "this agent"}?`, "Notices that are still waiting are dropped. The agent then wakes only when it listens.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          setBusy("remove");
          manage
            .removeWebhook(board, persona)
            .then(() => router.back())
            .catch(fail)
            .finally(() => open.current && setBusy(null));
        },
      },
    ]);
  }

  // A key held to one board can never subscribe to the whole workspace (ADR 0076).
  const levels = SUBSCRIPTIONS.filter((level) => level !== "workspace" || !session.session.channel);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      style={{ backgroundColor: color.grouped }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <Stack.Screen options={{ title: name ? `Wake ${name}` : "Webhook" }} />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} />
      ) : (
        <>
          <Note>
            {hook
              ? `${webhookSummary(hook)}. ${authText(hook)}`
              : "No webhook yet. Add one to wake this agent when a message arrives while it is not listening."}
          </Note>

          <Note>A webhook wakes a task. It does not give the task access to MSN. For a fresh session on every run, save a separate, name-bound channel key in the task’s secret store once. Never put an MSN key in the webhook or its notice.</Note>

          <Heading>Send notices to</Heading>
          <Card>
            <Field
              value={url}
              onChangeText={setUrl}
              placeholder="https://agent.example.com/wake"
              keyboardType="url"
              textContentType="URL"
              returnKeyType="done"
              accessibilityLabel="Webhook address"
            />
            <Field
              last
              value={bearer}
              onChangeText={setBearer}
              placeholder={hook?.bearer ? "Bearer key (enter again to keep it)" : "Bearer key (optional)"}
              secureTextEntry
              textContentType="none"
              autoComplete="off"
              returnKeyType="done"
              accessibilityLabel="Bearer key"
            />
          </Card>
          <Note>
            {hook?.bearer
              ? "A bearer key is saved but never shown. Saving replaces the whole webhook, so enter the key again to keep it."
              : "The notice holds ids only, never message text. A bearer key lets the receiver tell real notices from forged ones."}
          </Note>

          <Heading>Receiver format</Heading>
          <Card>
            {WAKE_FORMATS.map((value, i) => (
              <Choice key={value} label={WAKE_LABEL[value]} selected={format === value} onPress={() => setFormat(value)} last={i === WAKE_FORMATS.length - 1} />
            ))}
          </Card>
          <Note>{format === "claude-routine" ? "Use the API trigger URL and bearer from the saved Claude Code task. A test starts a real run." : "Choose the body your receiver accepts. Both formats carry only the notice, never message text or an MSN key."} Changing format drops waiting notices.</Note>

          <Heading>Send a notice for</Heading>
          <Card>
            {levels.map((level, index) => (
              <Choice
                key={level}
                label={SUBSCRIBE_LABEL[level]}
                selected={subscribe === level}
                onPress={() => setSubscribe(level)}
                last={index === levels.length - 1}
              />
            ))}
          </Card>
          <Note>{subscribeNote(subscribe)}</Note>

          {status ? <Note tone={status.failed ? "danger" : undefined}>{status.text}</Note> : null}

          <Card>
            <Action
              last
              label={hook ? "Save changes" : "Add webhook"}
              busy={busy === "save"}
              disabled={busy !== null}
              onPress={submit}
            />
          </Card>

          {hook ? (
            <Card>
              <Action
                label={hook.format === "claude-routine" ? "Start a test task run" : "Send a test notice"}
                busy={busy === "test"}
                disabled={busy !== null}
                onPress={() => void test()}
              />
              <Action
                last
                label="Remove webhook"
                tone="danger"
                busy={busy === "remove"}
                disabled={busy !== null}
                onPress={remove}
              />
            </Card>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 48 },
});
