import { useEffect } from "react";
import { AppState } from "react-native";
import type { SessionController } from "./shared.ts";

/**
 * Pauses the live connection in the background and resumes it in the foreground, like
 * apps/ios's hook of the same name. Kept here because React Native 0.88 types
 * AppState.currentState as nullable.
 */
export function useAppLifecycle(controller: SessionController | null): void {
  useEffect(() => {
    if (!controller) return;
    const apply = (state: string | null | undefined) => {
      if (state === "active") controller.resume();
      else controller.pause();
    };
    apply(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", apply);
    return () => subscription.remove();
  }, [controller]);
}
