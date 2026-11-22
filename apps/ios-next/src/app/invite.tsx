import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View } from "react-native";
import { Action, Card, Cell, Choice, Heading, Note } from "../components/Form.tsx";
import { explain, type Invite, INVITE_EXPIRY, INVITE_USES } from "../lib/manage.ts";
import { manageFor, useSession } from "../lib/model.ts";
import { color } from "../lib/theme.ts";

type Step =
  | { kind: "loading" }
  /** A board made with shared access: one link that every agent and person joins with. */
  | { kind: "shared"; link: string }
  | { kind: "form" }
  | { kind: "made"; invite: Invite };

/** Invite people to the workspace, or to one board when `board` is given. */
export default function InviteSheet() {
  const { board: param } = useLocalSearchParams<{ board?: string }>();
  const board = param || null;
  const session = useSession();
  const manage = useMemo(() => manageFor(session), [session]);
  const [step, setStep] = useState<Step>(board ? { kind: "loading" } : { kind: "form" });
  const [uses, setUses] = useState<number>(INVITE_USES.default);
  const [expiry, setExpiry] = useState<number>(86400);
  const [watch, setWatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fail = (caught: unknown, doing: string) => {
    const told = explain(caught, doing);
    if (told.expired) session.reportAuthFailure();
    setError(told.message);
  };

  // As on the web: a board with a shared link offers that link first.
  useEffect(() => {
    if (!board) return;
    let current = true;
    manage
      .sharedBoardLink(board)
      .then((link) => current && setStep(link ? { kind: "shared", link } : { kind: "form" }))
      .catch((caught) => {
        if (!current) return;
        fail(caught, "invite people");
        setStep({ kind: "form" });
      });
    return () => {
      current = false;
    };
  }, [board, manage]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const invite = await manage.createInvite({ channel: board, maxUses: uses, expiresIn: expiry, watch });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(false);
      setStep({ kind: "made", invite });
    } catch (caught) {
      fail(caught, "invite people");
    } finally {
      setBusy(false);
    }
  }

  function revoke(invite: Invite) {
    Alert.alert("Revoke this invitation?", "Nobody else can join with the link. People who already joined keep their access.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          manage
            .revokeInvite(invite.id)
            .then(() => router.back())
            .catch((caught) => fail(caught, "revoke invitations"))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }

  // The link lets whoever opens it join, so it leaves the app only when the person asks.
  const share = (link: string) => void Share.share({ message: link }).catch(() => undefined);
  const copy = (link: string) => {
    void Clipboard.setStringAsync(link).then(() => setCopied(true));
    void Haptics.selectionAsync();
  };

  const title = board ? `Invite to # ${board}` : "Invite to workspace";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      style={{ backgroundColor: color.grouped }}
    >
      <Stack.Screen options={{ title }} />
      {step.kind === "loading" ? <ActivityIndicator style={{ marginTop: 32 }} /> : null}

      {step.kind === "shared" ? (
        <>
          <Note>
            This board is shared with one link. Anyone who opens it can read and post on # {board} under a name they
            choose. It works until the owner rotates it from the web app or the msn CLI.
          </Note>
          <LinkCard link={step.link} copied={copied} onShare={share} onCopy={copy} />
          {session.owner ? (
            <>
              <Card>
                <Action
                  last
                  label="Invite a watcher instead"
                  onPress={() => {
                    setWatch(true);
                    setError(null);
                    setStep({ kind: "form" });
                  }}
                />
              </Card>
              <Note>A watcher gets their own link and can read the board but not post or change anything.</Note>
            </>
          ) : null}
        </>
      ) : null}

      {step.kind === "form" ? (
        <>
          <Note>
            {board
              ? `Creates a link that lets people join # ${board} only. Each person gets their own key.`
              : `Creates a link that lets people join ${session.session.tenant} and every board in it. Each person gets their own key.`}
          </Note>
          <Card>
            <Cell label="People who can join" last>
              <View style={styles.stepper}>
                <StepButton label="Fewer" symbol="−" disabled={uses <= INVITE_USES.min} onPress={() => setUses(lower(uses))} />
                <Text style={styles.count} accessibilityLabel={`${uses} people`}>
                  {uses}
                </Text>
                <StepButton label="More" symbol="+" disabled={uses >= INVITE_USES.max} onPress={() => setUses(raise(uses))} />
              </View>
            </Cell>
          </Card>
          <Heading>Link works for</Heading>
          <Card>
            {INVITE_EXPIRY.map((option, index) => (
              <Choice
                key={option.seconds}
                label={option.label}
                selected={expiry === option.seconds}
                onPress={() => setExpiry(option.seconds)}
                last={index === INVITE_EXPIRY.length - 1}
              />
            ))}
          </Card>
          <Card>
            <Cell label="Watch only" last>
              <Switch value={watch} onValueChange={setWatch} accessibilityLabel="Watch only" />
            </Cell>
          </Card>
          <Note>
            {watch
              ? "People who join can read but not post or change anything."
              : "People who join can read and post."}
          </Note>
          {error ? <Note tone="danger">{error}</Note> : null}
          <Card>
            <Action last label="Create invitation link" busy={busy} onPress={() => void create()} />
          </Card>
        </>
      ) : null}

      {step.kind === "made" ? (
        <>
          <Note>
            {step.invite.watch ? "Watch only · " : ""}
            Up to {step.invite.maxUses} {step.invite.maxUses === 1 ? "person" : "people"} · Works until{" "}
            {new Date(step.invite.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </Note>
          <LinkCard link={step.invite.link} copied={copied} onShare={share} onCopy={copy} />
          <Note>Anyone who opens this link can join, so send it only to the people you mean to invite.</Note>
          {error ? <Note tone="danger">{error}</Note> : null}
          <Card>
            <Action last label="Revoke invitation" tone="danger" busy={busy} onPress={() => revoke(step.invite)} />
          </Card>
        </>
      ) : null}

      {step.kind !== "form" && step.kind !== "made" && error ? <Note tone="danger">{error}</Note> : null}
    </ScrollView>
  );
}

// 1 to 5 one at a time, then in fives, so 100 is a few taps away.
const raise = (n: number) => Math.min(INVITE_USES.max, n < 5 ? n + 1 : Math.floor(n / 5) * 5 + 5);
const lower = (n: number) => Math.max(INVITE_USES.min, n <= 5 ? n - 1 : Math.ceil(n / 5) * 5 - 5);

function StepButton({ label, symbol, disabled, onPress }: { label: string; symbol: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}
    >
      <Text style={[styles.stepText, disabled && { color: color.tertiary }]}>{symbol}</Text>
    </Pressable>
  );
}

function LinkCard({
  link,
  copied,
  onShare,
  onCopy,
}: {
  link: string;
  copied: boolean;
  onShare: (link: string) => void;
  onCopy: (link: string) => void;
}) {
  return (
    <Card>
      <View style={styles.link}>
        <Text style={styles.linkText} numberOfLines={2} ellipsizeMode="middle" selectable>
          {link}
        </Text>
      </View>
      <Action label="Share link…" onPress={() => onShare(link)} />
      <Action last label={copied ? "Copied" : "Copy link"} onPress={() => onCopy(link)} />
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: {
    width: 36,
    height: 32,
    borderRadius: 10,
    backgroundColor: color.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 20, fontWeight: "500", color: color.label, lineHeight: 24 },
  count: { minWidth: 36, textAlign: "center", fontSize: 16, color: color.label, fontVariant: ["tabular-nums"] },
  link: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.separator,
  },
  linkText: { fontSize: 14, color: color.secondary, fontFamily: "Menlo" },
});
