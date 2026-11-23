import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import { Backdrop } from "../components/Backdrop.tsx";
import { model, SessionContext } from "../lib/model.ts";
import { useAppLifecycle } from "../lib/lifecycle.ts";
import { useStore } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";

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

  // Navigation paints its own background; clear it so the sky shows behind every screen.
  const dark = useColorScheme() === "dark";
  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: "transparent" } };

  // Keep the splash screen's blank frame until the keychain has been read.
  if (phase.kind === "hydrating") return null;

  return (
    <ThemeProvider value={theme}>
      <SessionContext.Provider value={session}>
        <StatusBar style="auto" />
        {/* One sky behind every screen; screens stay transparent so it shows through their glass. */}
        <View style={{ flex: 1 }}>
          <Backdrop />
          <Stack
            screenOptions={{
              headerBackButtonDisplayMode: "minimal",
              contentStyle: { backgroundColor: "transparent" },
            }}
          >
            <Stack.Protected guard={session !== null}>
              <Stack.Screen name="index" options={{ title: "Boards", headerLargeTitleEnabled: true }} />
              <Stack.Screen name="board/[name]" options={{ title: "" }} />
              <Stack.Screen name="agent-connectors" options={{ title: "Agent connectors", contentStyle: { backgroundColor: color.grouped } }} />
              <Stack.Screen name="agents" options={{ title: "Agents" }} />
              <Stack.Screen
                name="invite"
                options={{
                  title: "Invite",
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.75, 1],
                  sheetGrabberVisible: true,
                  contentStyle: { backgroundColor: color.grouped },
                }}
              />
              <Stack.Screen
                name="webhook"
                options={{
                  title: "Webhook",
                  presentation: "formSheet",
                  sheetAllowedDetents: [1],
                  sheetGrabberVisible: true,
                  contentStyle: { backgroundColor: color.grouped },
                }}
              />
              <Stack.Screen
                name="account"
                options={{
                  title: "Account",
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.5, 1],
                  sheetGrabberVisible: true,
                  contentStyle: { backgroundColor: color.grouped },
                }}
              />
            </Stack.Protected>
            <Stack.Protected guard={session === null}>
              <Stack.Screen name="welcome" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
        </View>
      </SessionContext.Provider>
    </ThemeProvider>
  );
}
