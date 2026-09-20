import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppModel } from "../core/appModel.ts";
import { Banner, Button, Field, Segmented, Text } from "../components/ui.tsx";
import { colors, spacing } from "../components/theme.ts";

type Mode = "key" | "create" | "invite";

const MODES = [
  { value: "key", label: "Access key" },
  { value: "create", label: "New workspace" },
  { value: "invite", label: "Invitation" },
] as const;

export function SignInScreen({ model, notice }: { model: AppModel; notice: string | null }) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>("key");
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
  const ready = origin.trim() && tenant.trim() && needsSecret && (mode === "key" || username.trim());

  async function submit() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
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
          <Text style={{ color: colors.muted }}>Connect this device to a workspace.</Text>
        </View>

        {notice ? <Banner tone="warning">{notice}</Banner> : null}

        <Segmented options={MODES} value={mode} onChange={(next) => { setMode(next); setError(null); }} />

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

        <View style={styles.rememberRow}>
          <View style={{ flex: 1 }}>
            <Text accessibilityRole="header">Remember on this device</Text>
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              Stored in the iOS keychain, only while unlocked, never backed up.
            </Text>
          </View>
          <Switch
            value={remember}
            onValueChange={setRemember}
            accessibilityLabel="Remember on this device"
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>

        {error ? <Banner tone="danger">{error}</Banner> : null}

        <Button
          variant="primary"
          label={mode === "key" ? "Connect" : mode === "create" ? "Create workspace" : "Join workspace"}
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
});
