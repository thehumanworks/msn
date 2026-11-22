import { router } from "expo-router";
import { Alert } from "react-native";
import { confirmsDelete, explain } from "./manage.ts";
import { boardList, manageFor } from "./model.ts";
import { type ChannelListState, type SessionController, Store, useStore } from "./shared.ts";

/** Whether the boards list says this board is archived (ADR 0046). False until the list has loaded. */
export function useArchived(board: string): boolean {
  const list = useStore(boardList);
  // The list's own store changes on every reload; subscribe to it only when it exists.
  const state = useStore(list?.state ?? NO_LIST);
  return state.channels.some((channel) => channel.name === board && channel.archivedAt !== null);
}

// Stands in until the boards screen has made its list controller.
const NO_LIST = new Store<ChannelListState>({ phase: "loading", channels: [], error: null, unread: new Map() });

export function openInvite(board: string | null) {
  router.push({ pathname: "/invite", params: board ? { board } : {} });
}

export function openAgents(board: string) {
  router.push({ pathname: "/agents", params: { board } });
}

/**
 * Archive or unarchive a board. Archiving asks first: it ends what agents are doing there, though
 * nothing is deleted and it can be undone.
 */
export function setArchived(session: SessionController, board: string, archived: boolean) {
  const run = async () => {
    const list = boardList.get();
    let failure: string | null;
    if (list) failure = await list.setArchived(board, archived);
    else {
      try {
        await session.api.setArchived(board, archived, session.signal);
        failure = null;
      } catch (error) {
        const told = explain(error, "archive boards");
        if (told.expired) session.reportAuthFailure();
        failure = told.message;
      }
    }
    if (failure) Alert.alert(archived ? "Could not archive the board" : "Could not unarchive the board", failure);
  };
  if (!archived) return void run();
  Alert.alert(
    `Archive # ${board}?`,
    "It leaves the board list and becomes read-only for everyone, agents included. Nothing is deleted, and you can unarchive it later.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", onPress: () => void run() },
    ],
  );
}

/**
 * Delete a board for good (ADR 0080). Deleting cannot be undone, so the person types the board's
 * name first. `onDeleted` runs once the server has confirmed it.
 */
export function deleteBoard(session: SessionController, board: string, onDeleted?: () => void) {
  Alert.prompt(
    `Delete # ${board}?`,
    `Its messages, files, agents, webhooks and access links are deleted for everyone and cannot be recovered. Archive it instead to keep the history.\n\nType ${board} to delete it.`,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: (typed?: string) => {
          if (!confirmsDelete(typed, board)) {
            Alert.alert("Nothing was deleted", "The name you typed did not match the board's name.");
            return;
          }
          void (async () => {
            try {
              await manageFor(session).deleteBoard(board);
            } catch (error) {
              const told = explain(error, "delete boards");
              if (told.expired) session.reportAuthFailure();
              Alert.alert("Could not delete the board", told.message);
              return;
            }
            onDeleted?.();
            void boardList.get()?.load();
          })();
        },
      },
    ],
    "plain-text",
  );
}
