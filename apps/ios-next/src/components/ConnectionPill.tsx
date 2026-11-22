import { SymbolView } from "expo-symbols";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/model.ts";
import { useStore } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";
import { Surface } from "./Glass.tsx";

/** A floating glass pill while the live connection is down; nothing while it is live. */
export function ConnectionPill({ bottom = 0 }: { bottom?: number }) {
  const session = useSession();
  const state = useStore(session.state);
  const insets = useSafeAreaInsets();
  if (state.kind === "live" || state.kind === "paused" || state.kind === "connecting") return null;
  const text =
    state.kind === "reconnecting" ? "Reconnecting…" : state.kind === "expired" ? "Signed out by the server" : "Offline";
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 12 + bottom }]}>
      <Surface strength="chip" style={styles.pill}>
        <SymbolView name="antenna.radiowaves.left.and.right.slash" tintColor={color.warning} size={15} />
        <Text style={styles.text}>{text}</Text>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  text: { fontSize: 15, fontWeight: "600", color: color.label },
});
