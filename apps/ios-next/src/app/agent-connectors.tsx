import * as Clipboard from "expo-clipboard";
import { useIsFocused, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Keyboard, ScrollView, StyleSheet, Text } from "react-native";
import { Action, Card, Choice, Field, Heading, Note } from "../components/Form.tsx";
import {
  AgentConnectors,
  type AgentUser,
  type ChannelMember,
  type IssuedKey,
  validChannel,
} from "../lib/agentConnectors.ts";
import { useArchived } from "../lib/boardActions.ts";
import { ChannelAgentSetup } from "../lib/channelAgentSetup.ts";
import { transport, useSession } from "../lib/model.ts";
import { useOwned, useStore } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";

const access = (watch: boolean) => (watch ? "Watch only" : "Read and reply");

export default function AgentConnectorsScreen() {
  const { board } = useLocalSearchParams<{ board?: string }>();
  const session = useSession();
  const connection = useStore(session.state);
  const focused = useIsFocused();
  if (!focused || !connection.ready || connection.kind === "paused") return null;
  if (!validChannel(board)) return <Note>Open Agent connectors from a channel.</Note>;
  if (!session.owner || session.watchOnly || session.session.channel)
    return <Note>Only the workspace owner can manage agent connectors.</Note>;
  return <OwnerScreen key={`${session.session.origin}/${session.session.tenant}/${board}`} board={board} />;
}

function OwnerScreen({ board }: { board: string }) {
  const session = useSession();
  const epoch = session.signal;
  const setup = useOwned(
    () => {
      const current = new ChannelAgentSetup(
        new AgentConnectors(session.session, transport),
        board,
        epoch,
        () => session.reportAuthFailure(),
      );
      void current.users();
      return current;
    },
    (current) => current.close(),
    [session, epoch, board],
  );
  const archived = useArchived(board);
  return setup ? <Setup setup={setup} archived={archived} /> : <ActivityIndicator />;
}

function confirmRemoval(setup: ChannelAgentSetup, who: AgentUser) {
  Alert.alert(
    `Remove ${who.name} from #${setup.board}?`,
    `All installations of agent ${who.id} lose access to this channel. Its user and other channels are not removed.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Remove from channel", style: "destructive", onPress: () => void setup.remove(who.id) },
    ],
  );
}

function Setup({ setup, archived }: { setup: ChannelAgentSetup; archived: boolean }) {
  const state = useStore(setup.state);
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const { directory, selected, detail, issued, busy } = state;
  const board = setup.board;
  const member = setup.member();
  const byId = new Map(directory?.members.map((m) => [m.id, m] as const));
  const localIds = new Set(directory?.users.map((u) => u.id));
  const foreign = directory?.members.filter((m) => !localIds.has(m.id)) ?? [];
  const present = (m?: ChannelMember) => (m ? access(m.watchOnly) : "Not in this channel");
  return (
    <ScrollView
      key={issued ? "key" : (selected?.id ?? "choose")}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Heading>{`${setup.home} / #${board}`}</Heading>
      {archived ? (
        <Note>This channel is archived. You can remove access or disconnect an installation.</Note>
      ) : null}
      {state.error ? (
        <>
          <Note tone="danger">{state.error}</Note>
          <Card>
            <Action last label="Refresh" disabled={busy} onPress={() => void setup.refresh()} />
          </Card>
        </>
      ) : null}
      {!selected && directory ? (
        <>
          <Note>
            Create or choose a persistent MSN user. You can add it to this channel and connect its host
            without starting the agent.
          </Note>
          {!archived ? (
            <Card>
              <Field
                placeholder="New agent name"
                accessibilityLabel="New agent name"
                value={name}
                onChangeText={setName}
                editable={!busy}
                returnKeyType="done"
              />
              <Action
                last
                label="Create agent user"
                disabled={busy || !name.trim()}
                onPress={() => {
                  Keyboard.dismiss();
                  void setup.create(name.trim());
                  setName("");
                }}
              />
            </Card>
          ) : null}
          {directory.users.length ? (
            <>
              <Heading>Your agent users</Heading>
              <Card>
                {directory.users.map((u, i) => (
                  <Action
                    key={u.id}
                    label={u.name}
                    detail={`${present(byId.get(u.id))} · ${u.id}`}
                    disabled={busy}
                    last={i === directory.users.length - 1}
                    onPress={() => void setup.select(u.id)}
                  />
                ))}
              </Card>
            </>
          ) : null}
          {foreign.length ? (
            <>
              <Heading>Members from other workspaces</Heading>
              <Note>Only their operator can issue installation keys. You can remove their access here.</Note>
              <Card>
                {foreign.slice(0, more ? undefined : 12).map((u) => (
                  <Action
                    key={u.id}
                    label={`Remove ${u.name} · ${u.id.slice(0, 8)} · ${access(u.watchOnly)}`}
                    disabled={busy}
                    tone="danger"
                    onPress={() => confirmRemoval(setup, u)}
                  />
                ))}
                {!more && foreign.length > 12 ? (
                  <Action last label={`Show all ${foreign.length} members`} onPress={() => setMore(true)} />
                ) : null}
              </Card>
            </>
          ) : null}
        </>
      ) : null}
      {selected && issued ? (
        <KeyReceipt key={issued.id} issued={issued} name={selected.name} setup={setup} />
      ) : null}
      {selected && !issued ? (
        <>
          <Text style={styles.title}>{selected.name}</Text>
          <Note>MSN agent user: {selected.id}</Note>
          {detail ? (
            <>
              {member ? (
                <>
                  <Note>{`Access to #${board}: ${access(member.watchOnly)}.`}</Note>
                  {!archived ? <InstallForm setup={setup} busy={busy} /> : null}
                </>
              ) : !archived ? (
                <AddForm setup={setup} busy={busy} />
              ) : (
                <Note>This agent is not a member.</Note>
              )}
              {detail.installations.length ? (
                <>
                  <Heading>Host installations</Heading>
                  <Note>
                    Disconnecting one host does not affect other installations or channel memberships.
                  </Note>
                  {detail.installations.map((i) => (
                    <Card key={i.id}>
                      <Note>{`${i.label} · ${i.kind} · ${i.id.slice(0, 8)}`}</Note>
                      <Action
                        last
                        label={`Disconnect ${i.label}`}
                        tone="danger"
                        disabled={busy}
                        onPress={() =>
                          Alert.alert(
                            `Disconnect ${i.label}?`,
                            `Installation ${i.id} will lose access as ${selected.name} in every channel.`,
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Disconnect",
                                style: "destructive",
                                onPress: () => void setup.disconnect(i.id),
                              },
                            ],
                          )
                        }
                      />
                    </Card>
                  ))}
                </>
              ) : null}
              {member ? (
                <Card>
                  <Action
                    last
                    label={`Remove from #${board}`}
                    tone="danger"
                    disabled={busy}
                    onPress={() => confirmRemoval(setup, selected)}
                  />
                </Card>
              ) : null}
            </>
          ) : null}
          <Card>
            <Action
              last
              label="Choose another agent user"
              disabled={busy}
              onPress={() => void setup.users()}
            />
          </Card>
        </>
      ) : null}
      {busy ? <ActivityIndicator accessibilityLabel="Loading agent settings" /> : null}
    </ScrollView>
  );
}

function AddForm({ setup, busy }: { setup: ChannelAgentSetup; busy: boolean }) {
  const [watch, setWatch] = useState(false);
  return (
    <>
      <Heading>Channel access</Heading>
      <Note>This user has not joined this channel.</Note>
      <Card>
        <Choice label="Read and reply" selected={!watch} onPress={() => setWatch(false)} />
        <Choice label="Watch only" selected={watch} onPress={() => setWatch(true)} />
        <Action last label={`Add to #${setup.board}`} disabled={busy} onPress={() => void setup.add(watch)} />
      </Card>
    </>
  );
}

function InstallForm({ setup, busy }: { setup: ChannelAgentSetup; busy: boolean }) {
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState("");
  const [showChannels, setShowChannels] = useState(false);
  const { selected, detail } = useStore(setup.state);
  if (!detail || !selected) return null;
  return (
    <>
      <Heading>Connect a host</Heading>
      <Note>
        In the host’s settings add this remote MCP server (Streamable HTTP). Choose Bearer or a secret
        Authorization header.
      </Note>
      <Text selectable style={styles.url}>
        {setup.endpoint}
      </Text>
      <Card>
        <Action
          last
          label="Copy server URL"
          onPress={() =>
            void Clipboard.setStringAsync(setup.endpoint).then(
              () => setCopied("Copied the server URL."),
              () => setCopied("Could not copy the URL."),
            )
          }
        />
      </Card>
      {copied ? <Note>{copied}</Note> : null}
      <Note>
        A key acts as {selected.name} in all its current and future channels, not just this one. Watch-only
        access stays read-only.
      </Note>
      {detail.channels.length > 1 ? (
        <Card>
          <Action
            last
            label={showChannels ? "Hide channel list" : `Review all ${detail.channels.length} channels`}
            onPress={() => setShowChannels(!showChannels)}
          />
        </Card>
      ) : null}
      {showChannels ? (
        <Note>
          {detail.channels.map((m) => `${m.tenant} / #${m.channel} · ${access(m.watchOnly)}`).join("\n")}
        </Note>
      ) : null}
      <Card>
        <Field
          accessibilityLabel="Host label"
          placeholder="Host label, e.g. My assistant"
          editable={!busy}
          value={label}
          onChangeText={setLabel}
          returnKeyType="done"
        />
        <Action
          last
          label="Create installation key"
          disabled={busy || !label.trim()}
          onPress={() => {
            Keyboard.dismiss();
            void setup.issue(label);
          }}
        />
      </Card>
    </>
  );
}

function KeyReceipt({ issued, name, setup }: { issued: IssuedKey; name: string; setup: ChannelAgentSetup }) {
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      const key = setup.copyableKey(issued.id);
      if (!key) return;
      await Clipboard.setStringAsync(key, {
        ios: { localOnly: true, expiresAt: new Date(Date.now() + 120_000) },
      });
      setMessage("Copied for 2 minutes on this iPhone. Paste it into the host’s secret settings.");
    } catch {
      setMessage("Could not copy the key. Try again or reveal it to enter it manually.");
    }
  }
  return (
    <>
      <Text style={styles.title}>Installation key ready</Text>
      <Note>
        Copy the key for {name} before leaving this screen or switching apps. MSN cannot show it again. If you
        lose it, disconnect this installation and create another.
      </Note>
      <Card>
        <Action label="Copy installation key" onPress={() => void copy()} />
        <Action last label={revealed ? "Hide key" : "Reveal key"} onPress={() => setRevealed(!revealed)} />
      </Card>
      {revealed ? <Text style={styles.secret}>{issued.token}</Text> : null}
      {message ? <Note>{message}</Note> : null}
      <Note>
        For Bearer, paste the key by itself. For a custom header, use Authorization: Bearer followed by a
        space and the key. Never put it in a message, webhook or agent prompt.
      </Note>
      <Card>
        <Action last label="Done · forget key" onPress={() => void setup.refresh()} />
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 60 },
  title: { fontSize: 22, fontWeight: "600", color: color.label },
  url: { color: color.label, fontSize: 16 },
  secret: { fontFamily: "Menlo", fontSize: 15, color: color.label, padding: 8 },
});
