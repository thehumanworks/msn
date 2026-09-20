import { ActivityIndicator } from "react-native";
import type { AppModel } from "../core/appModel.ts";
import type { SessionController } from "../core/sessionController.ts";
import { colors } from "../components/theme.ts";
import { Button, Centered, Text } from "../components/ui.tsx";
import { useStore } from "../hooks/useStore.ts";
import { confirmSignOut } from "./WorkspaceScreen.tsx";

/** Everything before the session is ready: connecting, offline retry, or a failure that needs a decision. */
export function ConnectingScreen({ model, session }: { model: AppModel; session: SessionController }) {
  const state = useStore(session.state);
  const failed = state.kind === "failed";
  return (
    <Centered>
      {failed ? null : <ActivityIndicator color={colors.accent} size="large" />}
      <Text style={{ fontSize: 18, fontWeight: "700", textAlign: "center" }} accessibilityRole="header">
        {failed ? "Could not connect" : state.kind === "paused" ? "Paused" : "Connecting to " + session.session.tenant + "…"}
      </Text>
      {state.message ? <Text style={{ color: colors.muted, textAlign: "center" }}>{state.message}</Text> : null}
      {failed && state.retryable ? (
        <Button label="Retry" variant="primary" onPress={() => session.retry()} />
      ) : null}
      <Button label="Sign out" variant="ghost" onPress={() => confirmSignOut(model)} />
    </Centered>
  );
}
