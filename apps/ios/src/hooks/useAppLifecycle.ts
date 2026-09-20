import { useEffect } from "react";
import { AppState } from "react-native";
import type { SessionController } from "../core/sessionController.ts";

/**
 * Claims the event subscription only while the app is active. `inactive` (app switcher, system
 * sheets) and `background` both pause; the controller replays from its stored cursor on resume.
 * The initial state is applied too, so a session adopted while not active never starts polling.
 */
export function useAppLifecycle(controller: SessionController | null): void {
  useEffect(() => {
    if (!controller) return;
    const apply = (state: string) => {
      if (state === "active") controller.resume();
      else controller.pause();
    };
    apply(AppState.currentState);
    const subscription = AppState.addEventListener("change", apply);
    return () => subscription.remove();
  }, [controller]);
}
