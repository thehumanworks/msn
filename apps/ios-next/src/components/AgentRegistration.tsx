import { getRandomValues } from "expo-crypto";
import { useRef, useState } from "react";
import { Keyboard } from "react-native";
import { ApiError } from "../../../ios/src/core/errors.ts";
import { explain, type Manage } from "../lib/manage.ts";
import { useSession } from "../lib/model.ts";
import { newPersonaId, validName } from "../lib/persona.ts";
import { Action, Card, Field, Note } from "./Form.tsx";

// Use native secure randomness even in debug builds. The board credential never enters UI state.
const secureBytes = (count: number) => getRandomValues(new Uint8Array(count));

export function AgentRegistration({
  board, plain, manage, reload,
}: {
  board: string;
  plain: boolean;
  manage: Manage;
  reload: () => Promise<void>;
}) {
  const session = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const submitting = useRef(false);
  // If a write succeeded but its reply was lost, retry the same PUT, not a new agent.
  const attempt = useRef<{ name: string; id: string } | null>(null);

  async function submit() {
    if (submitting.current || session.watchOnly || (plain && !session.owner)) return;
    const displayName = name.trim();
    if (!plain) {
      const problem = validName(displayName);
      if (problem) return setNotice({ text: problem, error: true });
    }
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    Keyboard.dismiss();
    try {
      if (plain) {
        await manage.enableAgents(board, secureBytes, session.signal);
      } else {
        if (attempt.current?.name !== displayName)
          attempt.current = { name: displayName, id: newPersonaId(secureBytes) };
        await manage.registerAgent(board, attempt.current.id, displayName, session.signal);
        attempt.current = null;
        setName("");
        setNotice({ text: `${displayName} is registered.` });
      }
      await reload();
    } catch (error) {
      const told = explain(error, plain ? "enable agents" : "register agents");
      if (told.expired) session.reportAuthFailure();
      setNotice({ text: told.message, error: true });
      if (error instanceof ApiError && error.code === "persona_name_conflict") await reload();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Note>
        {plain
          ? `Enable agents on #${board} to give this channel a shared board link. Its messages stay here. Anyone you give the link to can read the board and post as any registered agent. The link is not sent automatically.`
          : "Register the name the agent will use on this board. This does not start an agent or give it a separate key."}
      </Note>
      <Card>
        {!plain ? (
          <Field
            accessibilityLabel="Agent display name"
            placeholder="Agent display name"
            value={name}
            editable={!busy}
            onChangeText={(value) => { setName(value); setNotice(null); }}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
          />
        ) : null}
        <Action
          last
          label={plain ? "Enable agents on this channel" : "Register agent"}
          busy={busy}
          disabled={!plain && !name.trim()}
          onPress={() => void submit()}
        />
      </Card>
      {notice ? <Note tone={notice.error ? "danger" : undefined}>{notice.text}</Note> : null}
    </>
  );
}
