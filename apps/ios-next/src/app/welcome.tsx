import * as Clipboard from "expo-clipboard";
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytes } from "expo-crypto";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Backdrop } from "../components/Backdrop.tsx";
import { Glass, GlassButton, Surface } from "../components/Glass.tsx";
import { offersCloudflare, signInWithCloudflare } from "../lib/cloudflareLogin.ts";
import { join } from "../lib/join.ts";
import { describeJoin, joinServer, parseJoinLink } from "../lib/joinLink.ts";
import { DEFAULT_ORIGIN, model, pending, transport } from "../lib/model.ts";
import { useStore } from "../lib/shared.ts";
import { color, glassTint, host } from "../lib/theme.ts";

// System label colors: dark ink on the light sky, white on the night sky.
const INK = color.label;
const SOFT = color.secondary;
const FAINT = color.tertiary;

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
  // Shown only for a server this app is associated with that signs people in with Cloudflare Access (ADR 0079).
  const [cloudflare, setCloudflare] = useState(false);
  const [cloudflareBusy, setCloudflareBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setCloudflare(false);
    const timer = setTimeout(() => {
      void offersCloudflare(server, transport).then((offered) => {
        if (live) setCloudflare(offered);
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [server]);

  const parsed = useMemo(() => (link.trim() ? parseJoinLink(link) : null), [link]);
  const needsName = parsed?.ok && parsed.link.kind !== "account";
  const needsServer = parsed?.ok && parsed.link.kind === "invite" && parsed.link.origin === null;
  const submitting = useRef(false);
  // Where the key goes: always on the card, with a warning for any server but the production one.
  const target = parsed?.ok ? joinServer(parsed.link, server) : null;
  const canJoin = keyMode
    ? Boolean(tenant.trim() && token.trim() && name.trim())
    : Boolean(parsed?.ok && target && (!needsName || name.trim()));

  async function paste() {
    const text = await Clipboard.getStringAsync();
    if (text) setLink(text.trim());
  }

  async function submit() {
    // A ref, not `busy`: two taps in one frame both see the old state.
    if (!canJoin || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    if (keyMode) {
      failure = await model.signInWithKey({
        origin: server.trim(),
        tenant,
        username: name.trim(),
        token,
        remember: true,
      });
    } else if (parsed?.ok) {
      const result = await join(parsed.link, name, server.trim(), {
        model,
        fetchImpl: transport,
        randomBytes: getRandomBytes,
      });
      if ("error" in result) failure = result.error;
      else pending.board = result.board;
    }
    submitting.current = false;
    setBusy(false);
    if (failure) {
      setError(failure);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  async function cloudflareSignIn() {
    if (submitting.current) return;
    submitting.current = true;
    setCloudflareBusy(true);
    setError(null);
    const result = await signInWithCloudflare(server, {
      fetchImpl: transport,
      randomBytes: getRandomBytes,
      sha256Hex: (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
      openAuthSession: (url, callback, options) => WebBrowser.openAuthSessionAsync(url, callback, options),
    });
    let failure: string | null = null;
    if ("error" in result) failure = result.error;
    else if ("account" in result) failure = await model.signInWithKey({ ...result.account, remember: true });
    submitting.current = false;
    setCloudflareBusy(false);
    if (failure) {
      setError(failure);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else if ("account" in result) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function profileMenu(profileName: string, label: string) {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: label,
        options: ["Open", "Forget on this device", "Cancel"],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
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
      <Backdrop />
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
            <Surface style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </Surface>
          ) : null}

          <View style={styles.stack}>
            <Surface style={styles.card}>
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
                      <Glass isInteractive tintColor={glassTint.chip} style={styles.iconButton}>
                        <SymbolView name="doc.on.clipboard" tintColor={INK} size={18} />
                      </Glass>
                    </Pressable>
                  </View>
                  {parsed?.ok ? (
                    <View style={styles.row}>
                      <SymbolView
                        name={target?.official ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"}
                        tintColor={target?.official ? color.success : color.warning}
                        size={16}
                      />
                      <View style={styles.hintStack}>
                        <Text style={styles.hint}>{describeJoin(parsed.link)}</Text>
                        <Text style={styles.server} accessibilityLabel={`Server ${target?.host ?? "not valid"}`}>
                          {target ? `on ${target.host}` : "The server is not a valid address."}
                        </Text>
                        {target && !target.official ? (
                          <Text style={styles.warning}>
                            This is not msn.thehuman.sh. Join only if you trust {target.host}: it receives your key.
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ) : parsed ? (
                    <View style={styles.row}>
                      <SymbolView name="exclamationmark.triangle.fill" tintColor={color.warning} size={16} />
                      <Text style={styles.hint}>{parsed.error}</Text>
                    </View>
                  ) : (
                    <Text style={styles.hint}>
                      Ask a board's owner for its Invite link, or paste an account connection.
                    </Text>
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
            </Surface>

            <GlassButton
              label={keyMode ? "Sign in" : "Join"}
              onPress={submit}
              disabled={!canJoin}
              busy={busy}
              tint={color.tint}
            />
            {cloudflare && !keyMode ? (
              <GlassButton
                label="Sign in with Cloudflare"
                onPress={cloudflareSignIn}
                disabled={busy}
                busy={cloudflareBusy}
              />
            ) : null}
          </View>

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
              <View style={styles.stack}>
                {profiles.map((profile) => {
                  const label = `${profile.username} · ${profile.channel ? `# ${profile.channel}` : profile.tenant}`;
                  return (
                    <Pressable
                      key={profile.name}
                      onPress={() => void open(profile.name)}
                      onLongPress={() => profileMenu(profile.name, label)}
                      accessibilityHint="Long press to forget"
                    >
                      <Glass isInteractive tintColor={glassTint.surface} style={styles.profile}>
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
              </View>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.grouped },
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
    backgroundColor: color.fill,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  hint: { color: SOFT, fontSize: 14, flexShrink: 1 },
  hintStack: { flexShrink: 1, gap: 2 },
  server: { color: INK, fontSize: 14, fontWeight: "600" },
  warning: { color: color.warning, fontSize: 13 },
  error: { color: color.danger, fontSize: 15, fontWeight: "500", marginTop: 6 },
  links: { flexDirection: "row", justifyContent: "center", gap: 28, marginTop: 4 },
  link: { color: INK, fontSize: 15, fontWeight: "500", textDecorationLine: "underline" },
  section: {
    color: SOFT,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 22,
  },
  profile: {
    borderRadius: 22,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: INK, fontSize: 17, fontWeight: "700" },
  profileName: { color: INK, fontSize: 16, fontWeight: "600" },
  profileHost: { color: SOFT, fontSize: 13 },
});
