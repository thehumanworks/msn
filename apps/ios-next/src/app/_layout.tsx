import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { model, SessionContext } from "../lib/model.ts";
import { useAppLifecycle } from "../lib/lifecycle.ts";
import { useStore } from "../lib/shared.ts";

// Hydrate once per process: the model reopens the profile saved as active, if any.
let hydrating: Promise<void> | null = null;

export default function Layout() {
  const phase = useStore(model.state);
  const session = phase.kind === "connected" ? phase.controller : null;

  useEffect(() => {
    hydrating ??= model.hydrate();
  }, []);
  // The single event subscription runs only while the app is active.
  useAppLifecycle(session);

  // Keep the splash screen's blank frame until the keychain has been read.
  if (phase.kind === "hydrating") return null;

  return (
    <SessionContext.Provider value={session}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Protected guard={session !== null}>
          <Stack.Screen name="index" options={{ title: "Boards", headerLargeTitleEnabled: true }} />
          <Stack.Screen name="board/[name]" options={{ title: "" }} />
          <Stack.Screen
            name="account"
            options={{ title: "Account", presentation: "formSheet", sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true }}
          />
        </Stack.Protected>
        <Stack.Protected guard={session === null}>
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </SessionContext.Provider>
  );
}
