import { router } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { GlassButton } from "../components/Glass.tsx";
import { model, useSession } from "../lib/model.ts";
import { useStore } from "../lib/shared.ts";
import { color, host } from "../lib/theme.ts";

export default function Account() {
  const session = useSession();
  const state = useStore(session.state);
  const { username, tenant, origin, channel } = session.session;

  function signOut(forget: boolean) {
    const go = () => {
      router.dismissAll();
      void model.signOut(null, { forget });
    };
    if (!forget) return go();
    Alert.alert("Sign out and forget?", "The key is deleted from this iPhone. You will need a new link to come back.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: go },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: color.grouped }}>
      <View style={styles.card}>
        <Row label="Name" value={username} />
        <Row label={channel ? "Board" : "Workspace"} value={channel ? `# ${channel} · ${tenant}` : tenant} />
        <Row label="Server" value={host(origin)} />
        <Row label="Access" value={session.owner ? "Owner" : channel ? "This board only" : "Member"} />
        <Row label="Connection" value={state.kind} last />
      </View>
      <Text style={styles.note}>
        Your key is kept only in this iPhone's keychain. Signing out keeps it here so you can switch back; forgetting
        deletes it.
      </Text>
      <View style={{ gap: 12 }}>
        <GlassButton label="Switch account" textColor={color.label as unknown as string} onPress={() => signOut(false)} />
        <GlassButton label="Sign out and forget" textColor="#ff453a" onPress={() => signOut(true)} />
      </View>
    </ScrollView>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.row, !last && styles.divider]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={1} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  card: { backgroundColor: color.cell, borderRadius: 22, paddingHorizontal: 16, borderCurve: "continuous" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 13, gap: 16 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.separator },
  label: { fontSize: 16, color: color.label },
  value: { fontSize: 16, color: color.secondary, flexShrink: 1 },
  note: { fontSize: 13, color: color.secondary, paddingHorizontal: 8 },
});
