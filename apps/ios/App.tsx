import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppModel } from "./src/core/appModel.ts";
import { colors } from "./src/components/theme.ts";
import { EmptyState } from "./src/components/ui.tsx";
import { useAppLifecycle } from "./src/hooks/useAppLifecycle.ts";
import { useStore } from "./src/hooks/useStore.ts";
import { keychainStore } from "./src/native/secureStorage.ts";
import { ConnectingScreen } from "./src/screens/ConnectingScreen.tsx";
import { SignInScreen } from "./src/screens/SignInScreen.tsx";
import { WorkspaceScreen } from "./src/screens/WorkspaceScreen.tsx";

// The model owns every SessionController (and so the single event subscription).
const model = new AppModel(keychainStore);

export default function App() {
  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="light" />
        <Root />
      </View>
    </SafeAreaProvider>
  );
}

function Root() {
  const phase = useStore(model.state);
  const controller = phase.kind === "connected" ? phase.controller : null;
  const hydrated = useRef(false);

  // Hydrate exactly once, even when StrictMode replays effects in development.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    void model.hydrate();
  }, []);

  // Tear down the live session if the root is ever unmounted.
  useEffect(
    () => () => {
      const current = model.state.get();
      if (current.kind === "connected") current.controller.dispose();
    },
    [],
  );

  useAppLifecycle(controller);
  return <Phase phase={phase} />;
}

function Phase({ phase }: { phase: ReturnType<typeof model.state.get> }) {
  if (phase.kind === "hydrating") return <EmptyState title="Opening msn…" />;
  if (phase.kind === "signedOut") {
    return <SignInScreen model={model} notice={phase.notice} profiles={phase.profiles} />;
  }
  return <Connected controller={phase.controller} warning={phase.warning} />;
}

function Connected({
  controller,
  warning,
}: {
  controller: NonNullable<Extract<ReturnType<typeof model.state.get>, { kind: "connected" }>["controller"]>;
  warning: string | null;
}) {
  const connection = useStore(controller.state);
  // Ready-session views only; `key` remounts everything (and drops UI state) for a new session.
  if (!connection.ready) return <ConnectingScreen model={model} session={controller} />;
  return <WorkspaceScreen key={sessionKey(controller)} model={model} session={controller} warning={warning} />;
}

const keys = new WeakMap<object, number>();
let nextKey = 1;
function sessionKey(controller: object): number {
  let key = keys.get(controller);
  if (key === undefined) {
    key = nextKey++;
    keys.set(controller, key);
  }
  return key;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg } });
