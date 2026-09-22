import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppModel } from "../core/appModel.ts";
import type { ProfileSummary } from "../core/profileStorage.ts";
import { Banner, Button, Field, Segmented, Text } from "../components/ui.tsx";
import { colors, radius, spacing } from "../components/theme.ts";

type Mode = "connection" | "key" | "create" | "invite";

const MODES = [
  { value: "connection", label: "Account" },
  { value: "key", label: "Access key" },
  { value: "create", label: "New workspace" },
  { value: "invite", label: "Invitation" },
] as const;

function host(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

export function SignInScreen({
  model,
  notice,
  profiles,
}: {
  model: AppModel;
  notice: string | null;
  profiles: ProfileSummary[];
}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>("connection");
  const [connectionText, setConnectionText] = useState("");
  const [origin, setOrigin] = useState("");
  const [tenant, setTenant] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [channel, setChannel] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const needsSecret = mode === "key" ? token.trim() : mode === "invite" ? code.trim() : "x";
  const ready = mode === "connection" ? connectionText.trim() : origin.trim() && tenant.trim() && needsSecret && (mode === "key" || username.trim());

  async function submit() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    if (mode === "connection") {
      try {
        const data = JSON.parse(connectionText);
        if (connectionText.length > 65536 || typeof data.url !== "string" || typeof data.tenant !== "string" || typeof data.token !== "string" || typeof data.username !== "string") throw new Error("invalid");
        const result = await model.signInWithKey({ origin: data.url, tenant: data.tenant, username: data.username, token: data.token, remember });
        if (mounted.current) { setBusy(false); if (result) setError(result); else setConnectionText(""); }
      } catch { if (mounted.current) { setBusy(false); setError("Paste an exported MSN connection from the CLI or web client."); } }
      return;
    }
    const base = { origin, tenant, username, remember };
    const result =
      mode === "key"
        ? await model.signInWithKey({ ...base, token: token.trim() })
        : mode === "create"
          ? await model.createWorkspace({ ...base, ...(channel.trim() ? { channel: channel.trim() } : {}) })
          : await model.redeemInvitation({ ...base, code: code.trim() });
    if (!mounted.current) return;
    setBusy(false);
    if (result) setError(result);
  }

  async function openProfile(name: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await model.connectProfile(name);
    if (!mounted.current) return;
    setBusy(false);
    if (result) setError(result);
  }

  function confirmForget(profile: ProfileSummary) {
    Alert.alert(
      `Forget ${profile.username}?`,
      `This deletes the saved access key for ${profile.tenant} from this device. The key itself keeps working elsewhere.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () =>
            void model.forgetProfile(profile.name).then((result) => {
              if (mounted.current && result) setError(result);
            }),
        },
      ],
    );
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          padding: spacing.lg,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
          gap: spacing.lg,
        }}
      >
        <View style={{ gap: spacing.xs }}>
          <Text style={styles.title} accessibilityRole="header">
            msn
          </Text>
          <Text style={{ color: colors.muted }}>Sign in to read and coordinate your agent message boards.</Text>
        </View>

        {notice ? <Banner tone="warning">{notice}</Banner> : null}

        {profiles.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.section} accessibilityRole="header">
              Saved profiles
            </Text>
            {profiles.map((profile) => (
              <View key={profile.name} style={styles.profileRow}>
                <Pressable
                  style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                  disabled={busy}
                  onPress={() => void openProfile(profile.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Connect as ${profile.username} in ${profile.tenant}`}
                >
                  <Text style={{ fontWeight: "700" }}>
                    {profile.username}
                    <Text style={{ color: colors.muted, fontWeight: "400" }}> @ {profile.tenant}</Text>
                  </Text>
                  <Text style={{ color: colors.muted, fontSize: 13 }}>
                    {host(profile.origin)}
                    {profile.channel ? ` · #${profile.channel} only` : ""}
                  </Text>
                </Pressable>
                <Button
                  label="Forget"
                  variant="ghost"
                  onPress={() => confirmForget(profile)}
                  accessibilityHint={`Deletes the saved key for ${profile.username} from this device`}
                />
              </View>
            ))}
            <Text style={[styles.section, { marginTop: spacing.sm }]} accessibilityRole="header">
              New connection
            </Text>
          </View>
        ) : null}

        <Segmented options={MODES} value={mode} onChange={(next) => { setMode(next); setError(null); }} />

        {mode === "connection" ? <Field label="Account connection" value={connectionText} onChangeText={setConnectionText} secureTextEntry autoComplete="off" textContentType="none" placeholder="Paste MSN connection JSON" hint="Export your account connection once from the CLI or web client. All its channels are available here." /> : <>
        <Field
          label="Server"
          value={origin}
          onChangeText={setOrigin}
          placeholder="https://msn.example.com"
          keyboardType="url"
          textContentType="URL"
          hint="https only; http is accepted for localhost."
        />
        <Field
          label="Workspace"
          value={tenant}
          onChangeText={setTenant}
          placeholder="my-team"
          hint="Lowercase letters, digits, hyphens, underscores."
        />
        {mode === "key" ? (
          <Field
            label="Access key"
            value={token}
            onChangeText={setToken}
            secureTextEntry
            textContentType="none"
            autoComplete="off"
            placeholder="Paste your workspace key"
          />
        ) : null}
        {mode === "invite" ? (
          <Field
            label="Invitation code"
            value={code}
            onChangeText={setCode}
            secureTextEntry
            textContentType="none"
            autoComplete="off"
          />
        ) : null}
        <Field
          label={mode === "key" ? "Display name (optional)" : "Display name"}
          value={username}
          onChangeText={setUsername}
          placeholder="alice"
          hint={mode === "key" ? "Leave empty if your key already fixes a name." : undefined}
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {mode === "create" ? (
          <Field
            label="First channel (optional)"
            value={channel}
            onChangeText={setChannel}
            placeholder="general"
          />
        ) : null}

        </>}

        <View style={styles.rememberRow}>
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header">Save as a profile on this device</Text>
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              Named after you and the workspace. Stored in the iOS keychain, only while unlocked, never backed up.
            </Text>
          </View>
          <Switch
            value={remember}
            onValueChange={setRemember}
            accessibilityLabel="Save as a profile on this device"
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>

        {error ? <Banner tone="danger">{error}</Banner> : null}

        <Button
          variant="primary"
          label={mode === "connection" ? "Sign in" : mode === "key" ? "Connect" : mode === "create" ? "Create workspace" : "Join workspace"}
          onPress={submit}
          busy={busy}
          disabled={!ready}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 34, fontWeight: "800" },
  rememberRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  section: { color: colors.muted, fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
  },
});
