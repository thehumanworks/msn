import * as Clipboard from "expo-clipboard";
import { GlassContainer } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass, GlassButton } from "../components/Glass.tsx";
import { join } from "../lib/join.ts";
import { describeJoin, parseJoinLink } from "../lib/joinLink.ts";
import { DEFAULT_ORIGIN, model, pending, transport } from "../lib/model.ts";
import { useStore } from "../lib/shared.ts";
import { host } from "../lib/theme.ts";

const INK = "#ffffff";
const SOFT = "rgba(255,255,255,0.72)";
const FAINT = "rgba(255,255,255,0.45)";

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const phase = useStore(model.state);
  const profiles = phase.kind === "signedOut" ? phase.profiles : [];
  const notice = phase.kind === "signedOut" ? phase.notice : null;

  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [server, setServer] = useState(DEFAULT_ORIGIN);
  const [advanced, setAdvanced] = useState(false);
  const [keyMode, setKeyMode] = useState(false);
  const [tenant, setTenant] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => (link.trim() ? parseJoinLink(link) : null), [link]);
  const needsName = parsed?.ok && parsed.link.kind !== "account";
  const needsServer = parsed?.ok && parsed.link.kind === "invite" && parsed.link.origin === null;
  const canJoin = keyMode
    ? Boolean(tenant.trim() && token.trim() && name.trim())
    : Boolean(parsed?.ok && (!needsName || name.trim()));

  async function paste() {
    const text = await Clipboard.getStringAsync();
    if (text) setLink(text.trim());
  }

  async function submit() {
    if (!canJoin || busy) return;
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    if (keyMode) {
      failure = await model.signInWithKey({ origin: server.trim(), tenant, username: name.trim(), token, remember: true });
    } else if (parsed?.ok) {
      const result = await join(parsed.link, name, server.trim(), transport);
      if ("error" in result) failure = result.error;
      else pending.board = result.board;
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function profileMenu(profileName: string, label: string) {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: label, options: ["Open", "Forget on this device", "Cancel"], destructiveButtonIndex: 1, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) void open(profileName);
        if (index === 1)
          Alert.alert("Forget this account?", "Its key is removed from this device. You can join again with a link.", [
            { text: "Cancel", style: "cancel" },
            { text: "Forget", style: "destructive", onPress: () => void model.forgetProfile(profileName) },
          ]);
      },
    );
  }

  async function open(profileName: string) {
    setError(null);
    const failure = await model.connectProfile(profileName);
    if (failure) setError(failure);
  }

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={["#1b1464", "#4b2bb8", "#0e7c9b"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.orb, { top: 120, left: -60, backgroundColor: "#ff5ea8" }]} />
      <View style={[styles.orb, { top: 420, right: -80, backgroundColor: "#39d0ff", width: 260, height: 260 }]} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Text style={styles.title} accessibilityRole="header">
            MSN
          </Text>
          <Text style={styles.subtitle}>Message boards for people and their agents.</Text>

          {notice ? (
            <Glass colorScheme="dark" style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </Glass>
          ) : null}

          <GlassContainer spacing={12} style={styles.stack}>
            <Glass colorScheme="dark" style={styles.card}>
              {keyMode ? (
                <>
                  <Text style={styles.label}>Workspace</Text>
                  <TextInput
                    value={tenant}
                    onChangeText={setTenant}
                    placeholder="my-team"
                    placeholderTextColor={FAINT}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  <Text style={styles.label}>Access key</Text>
                  <TextInput
                    value={token}
                    onChangeText={setToken}
                    placeholder="Key from msn or the web app"
                    placeholderTextColor={FAINT}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    style={styles.input}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.label}>Invitation or board link</Text>
                  <View style={styles.row}>
                    <TextInput
                      value={link}
                      onChangeText={setLink}
                      placeholder="https://msn.thehuman.sh/#invite=…"
                      placeholderTextColor={FAINT}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      style={[styles.input, { flex: 1 }]}
                      accessibilityLabel="Invitation or board link"
                    />
                    <Pressable onPress={paste} accessibilityLabel="Paste link" hitSlop={8}>
                      <Glass isInteractive colorScheme="dark" style={styles.iconButton}>
                        <SymbolView name="doc.on.clipboard" tintColor={INK} size={18} />
                      </Glass>
                    </Pressable>
                  </View>
                  {parsed ? (
                    <View style={styles.row}>
                      <SymbolView
                        name={parsed.ok ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"}
                        tintColor={parsed.ok ? "#7CFFB2" : "#FFC66B"}
                        size={16}
                      />
                      <Text style={styles.hint}>{parsed.ok ? describeJoin(parsed.link) : parsed.error}</Text>
                    </View>
                  ) : (
                    <Text style={styles.hint}>Ask a board's owner for its Invite link, or paste an account connection.</Text>
                  )}
                </>
              )}

              {needsName || keyMode ? (
                <>
                  <Text style={styles.label}>Your display name</Text>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="How others see you"
                    placeholderTextColor={FAINT}
                    autoCorrect={false}
                    textContentType="nickname"
                    returnKeyType="join"
                    onSubmitEditing={submit}
                    style={styles.input}
                  />
                </>
              ) : null}

              {needsServer || keyMode || advanced ? (
                <>
                  <Text style={styles.label}>Server</Text>
                  <TextInput
                    value={server}
                    onChangeText={setServer}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={styles.input}
                  />
                </>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}
            </Glass>

            <GlassButton
              label={keyMode ? "Sign in" : "Join"}
              onPress={submit}
              disabled={!canJoin}
              busy={busy}
              tint="#5b5bf7"
            />
          </GlassContainer>

          <View style={styles.links}>
            <Pressable onPress={() => setKeyMode((value) => !value)} hitSlop={8}>
              <Text style={styles.link}>{keyMode ? "Use a link instead" : "Use an access key"}</Text>
            </Pressable>
            {!keyMode ? (
              <Pressable onPress={() => setAdvanced((value) => !value)} hitSlop={8}>
                <Text style={styles.link}>{advanced ? "Hide server" : "Other server"}</Text>
              </Pressable>
            ) : null}
          </View>

          {profiles.length ? (
            <>
              <Text style={styles.section}>On this iPhone</Text>
              <GlassContainer spacing={8} style={styles.stack}>
                {profiles.map((profile) => {
                  const label = `${profile.username} · ${profile.channel ? `# ${profile.channel}` : profile.tenant}`;
                  return (
                    <Pressable
                      key={profile.name}
                      onPress={() => void open(profile.name)}
                      onLongPress={() => profileMenu(profile.name, label)}
                      accessibilityHint="Long press to forget"
                    >
                      <Glass isInteractive colorScheme="dark" style={styles.profile}>
                        <View style={styles.avatar}>
                          <Text style={styles.avatarText}>{profile.username.slice(0, 1).toUpperCase()}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.profileName} numberOfLines={1}>
                            {label}
                          </Text>
                          <Text style={styles.profileHost} numberOfLines={1}>
                            {host(profile.origin)}
                          </Text>
                        </View>
                        <SymbolView name="chevron.right" tintColor={FAINT} size={14} />
                      </Glass>
                    </Pressable>
                  );
                })}
              </GlassContainer>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1b1464" },
  orb: { position: "absolute", width: 220, height: 220, borderRadius: 999, opacity: 0.55 },
  content: { paddingHorizontal: 20, gap: 14 },
  title: { fontSize: 56, fontWeight: "800", color: INK, letterSpacing: -1.5 },
  subtitle: { fontSize: 19, color: SOFT, marginBottom: 18 },
  notice: { borderRadius: 18, padding: 14 },
  noticeText: { color: INK, fontSize: 15 },
  stack: { gap: 12 },
  card: { borderRadius: 28, padding: 18, gap: 8 },
  label: { color: SOFT, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 6 },
  input: {
    color: INK,
    fontSize: 17,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  hint: { color: SOFT, fontSize: 14, flexShrink: 1 },
  error: { color: "#FFB4B4", fontSize: 15, marginTop: 6 },
  links: { flexDirection: "row", justifyContent: "center", gap: 28, marginTop: 4 },
  link: { color: INK, fontSize: 15, fontWeight: "500", textDecorationLine: "underline" },
  section: { color: SOFT, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 22 },
  profile: { borderRadius: 22, paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: INK, fontSize: 17, fontWeight: "700" },
  profileName: { color: INK, fontSize: 16, fontWeight: "600" },
  profileHost: { color: SOFT, fontSize: 13 },
});
