import { ChannelController } from "../core/channelController.ts";
import { ChannelListController } from "../core/channelList.ts";
import type { SessionController } from "../core/sessionController.ts";
import { useOwned } from "./useOwned.ts";

/** One list controller per session controller; a new session always gets a new one. */
export function useChannelList(session: SessionController): ChannelListController | null {
  return useOwned(
    () => {
      const list = new ChannelListController(session);
      void list.load();
      return list;
    },
    (list) => list.dispose(),
    [session],
  );
}

/** Exactly one controller per visible channel, keyed by (session, channel). */
export function useChannel(session: SessionController, channel: string): ChannelController | null {
  return useOwned(
    () => {
      const controller = new ChannelController(session, channel);
      controller.start();
      return controller;
    },
    (controller) => controller.dispose(),
    [session, channel],
  );
}
