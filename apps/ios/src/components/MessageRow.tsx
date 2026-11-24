import { memo, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { namesLine } from "../core/address.ts";
import { claimControl, claimNote } from "../core/claims.ts";
import { foldState } from "../core/fold.ts";
import { linksOf, parse, plainText } from "../core/markdown.ts";
import { REACTION_KINDS, type Message, type ReactionKind } from "../core/types.ts";
import { choiceMode, choiceNote } from "../core/questions.ts";
import { RECEIPTS_MEANING } from "../core/receipts.ts";
import { parseTaskActivity } from "../core/taskActivity.ts";
import { threadLabel, type ParentState } from "../core/threads.ts";
import { ownBubble, tickLabel, tickLayout } from "../core/ticks.ts";
import { Attachments } from "./Attachments.tsx";
import { DeliveryTicks } from "./DeliveryTicks.tsx";
import { formatTime } from "./format.ts";
import { MarkdownText, openMessageLink } from "./MarkdownText.tsx";
import { colors, mono, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

type Props = {
  message: Message;
  own: boolean;
  quoted: Message | undefined;
  selected: boolean;
  onReply: (message: Message) => void;
  /** A reply shown inside an open thread (ADR 0041). */
  nested?: boolean;
  /** A thread root's folded replies. */
  thread?: { replies: number; open: boolean; unseen: number };
  onToggleThread?: (root: number) => void;
  /** The parent of a reply whose parent is not loaded, once asked for. */
  parent?: ParentState;
  onLoadParent?: (id: number) => void;
  /** Processed-by line from explicit commits only (ADR 0040), or null. */
  receipts?: string | null;
  /** Opens the share sheet with a link to this message (ADR 0042); it offers Copy. */
  onShareLink?: (message: Message) => void;
  /** False where tapping a row does nothing, such as search results. */
  replyable?: boolean;
  /**
   * Long messages fold behind Show more (ADR 0050). Without it the body shows whole, as search
   * hits do, since the match may be below the fold.
   */
  onToggleFold?: (id: number) => void;
  /** The reader opened this message, or jumped to it. */
  unfolded?: boolean;
  /** Your display name, to mark your own reactions (ADR 0047). */
  me?: string;
  /** Toggles your reaction; absent where reactions are read only (archived boards, search). */
  onReact?: (message: Message, kind: ReactionKind) => void;
  /** Opens the editor on this message (ADR 0052); only passed for your own, writable messages. */
  onEditMessage?: (message: Message) => void;
  /** Starts a message that replaces this one (ADR 0068); only for your own, writable messages. */
  onReplaceMessage?: (message: Message) => void;
  /**
   * Takes this message (`release` false) or gives it back (ADR 0075); absent where nothing can
   * change (archived boards, search). The row offers it only where the server would allow it.
   */
  onClaim?: (message: Message, release: boolean) => void;
  /** The workspace owner's key: it may release anyone's claim (ADR 0075). */
  owner?: boolean;
  /** Answers a question (ADR 0065); absent where nothing can be posted (archived boards, search). */
  onAnswer?: (message: Message, choice: string) => void;
  /** Server origin, so attachment previews and downloads can open. */
  origin?: string;
  /** Channel key, used once a signed image link has expired. */
  token?: string;
  /** An answer to this question is in flight: its buttons stay locked until it settles. */
  answering?: boolean;
};

// The body's font size is 16; React Native's default line is about 1.2 times that.
const BODY_LINE = 20;

/** Reactions (ADR 0047): the symbol and spoken name of each kind. */
export const REACTION_LABELS: Record<ReactionKind, { symbol: string; label: string }> = {
  done: { symbol: "✓", label: "Done" },
  seen: { symbol: "👀", label: "Seen" },
  yes: { symbol: "👍", label: "Yes" },
  no: { symbol: "✗", label: "No" },
};

/** "Done 2: lead, dev" for VoiceOver and the row summary. */
export function reactionSummary(message: Message): string {
  return REACTION_KINDS.filter((kind) => message.reactions?.[kind]?.length)
    .map((kind) => {
      const names = message.reactions?.[kind] ?? [];
      return `${REACTION_LABELS[kind].label} ${names.length}: ${names.join(", ")}`;
    })
    .join("; ");
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function quoteText(message: Message, quoted: Message | undefined, parent: ParentState | undefined): string {
  if (quoted) return `${quoted.username}: ${preview(quoted.text)}`;
  if (parent?.status === "loading") return `Loading message #${message.replyTo}…`;
  if (parent?.status === "loaded") return `Message #${message.replyTo} is no longer available.`;
  if (parent?.status === "error") return `Could not load #${message.replyTo}: ${parent.error} Tap to retry.`;
  return `Reply to message #${message.replyTo}`;
}

function MessageRowImpl({
  message,
  own,
  quoted,
  selected,
  onReply,
  nested,
  thread,
  onToggleThread,
  parent,
  onLoadParent,
  receipts = null,
  onShareLink,
  replyable = true,
  onToggleFold,
  unfolded = false,
  me,
  onReact,
  onEditMessage,
  onReplaceMessage,
  onClaim,
  owner = false,
  onAnswer,
  answering = false,
  origin = "",
  token,
}: Props) {
  const [bodyHeight, setBodyHeight] = useState<number | undefined>(undefined);
  const fold = onToggleFold ? foldState(bodyHeight, BODY_LINE, unfolded) : { long: false, maxHeight: null };
  const foldLabel = fold.maxHeight === null ? "Show less" : "Show more";
  const reacted = REACTION_KINDS.filter((kind) => message.reactions?.[kind]?.length);
  const summary = reactionSummary(message);
  const task = parseTaskActivity(message);
  const structured = message.contentType === "application/json";
  // Formatted text (ADR 0043): VoiceOver reads the words without markup and offers each link.
  const formatted = !task && !structured;
  const tree = useMemo(() => (formatted ? parse(message.text) : null), [formatted, message.text]);
  const spoken = tree ? plainText(tree) : message.text;
  const links = tree ? linksOf(tree).slice(0, 5) : [];
  const who = own ? "You" : message.username;
  const ticks = tickLayout(ownBubble(message, me), message.delivery);
  // A question's buttons (ADR 0065): open only for the addressed name, locked once answered.
  const choices = message.choices && message.choices.length >= 2 ? message.choices : null;
  const mode = choices ? choiceMode(message, me, onAnswer !== undefined) : null;
  const canTap = mode === "open" && !answering;
  // Replace (ADR 0068): only a message nothing has replaced yet.
  const replaceable = onReplaceMessage !== undefined && message.replacedBy === undefined;
  // Take a request (ADR 0075): "Taking this" on a free message, "Release" for its holder or owner.
  const claimAction = onClaim ? claimControl(message, me, owner) : null;
  const claimLabel = claimAction === "take" ? "Taking this" : "Release";
  const canLoadParent =
    message.replyTo !== undefined &&
    onLoadParent !== undefined &&
    !quoted &&
    parent?.status !== "loading" &&
    parent?.status !== "loaded";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${who}${namesLine(message) ? ` to ${namesLine(message)}` : ""} at ${formatTime(message.createdAt)}: ${
        task ? `task ${task.body.action} ${task.body.task}` : preview(spoken)
      }${message.editedAt ? ", edited" : ""}${message.replacedBy ? `, replaced by message ${message.replacedBy}` : ""}${
        message.replaces ? `, replaces message ${message.replaces}` : ""
      }${message.claim ? `, ${claimNote(message.claim, me)}` : ""}${
        choices && mode ? `. Choices: ${choices.join(", ")}. ${choiceNote(message, mode)}` : ""
      }${summary ? `. Reactions: ${summary}` : ""}`}
      accessibilityHint={`${replyable ? "Double tap to reply. " : ""}Swipe up or down for more actions.`}
      // VoiceOver reads the row as one element, so its inner controls are offered as actions.
      accessibilityActions={[
        ...(replyable ? [{ name: "activate", label: "Reply" }] : []),
        ...(thread && onToggleThread
          ? [{ name: "toggleThread", label: threadLabel(thread.replies, thread.open, thread.unseen) }]
          : []),
        ...(fold.long ? [{ name: "toggleFold", label: foldLabel }] : []),
        ...(canLoadParent ? [{ name: "loadParent", label: `Load message #${message.replyTo}` }] : []),
        ...(onShareLink ? [{ name: "shareLink", label: "Copy or share link" }] : []),
        ...(onEditMessage ? [{ name: "editMessage", label: "Edit" }] : []),
        ...(replaceable ? [{ name: "replaceMessage", label: "Replace with a new message" }] : []),
        ...(claimAction
          ? [{ name: "claimMessage", label: claimAction === "take" ? "Taking this, so others skip it" : "Release" }]
          : []),
        ...(choices && canTap
          ? choices.map((choice, index) => ({ name: `answer${index}`, label: `Answer ${choice}` }))
          : []),
        ...(onReact
          ? REACTION_KINDS.map((kind) => ({
              name: `react_${kind}`,
              label: `${me && message.reactions?.[kind]?.includes(me) ? "Remove" : "React"} ${REACTION_LABELS[kind].label.toLowerCase()}`,
            }))
          : []),
        ...links.map((link, index) => ({ name: `openLink${index}`, label: `Open link ${link.label}` })),
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate" && replyable) onReply(message);
        else if (nativeEvent.actionName === "toggleThread") onToggleThread?.(message.id);
        else if (nativeEvent.actionName === "toggleFold") onToggleFold?.(message.id);
        else if (nativeEvent.actionName === "loadParent" && message.replyTo !== undefined)
          onLoadParent?.(message.replyTo);
        else if (nativeEvent.actionName === "shareLink") onShareLink?.(message);
        else if (nativeEvent.actionName === "editMessage") onEditMessage?.(message);
        else if (nativeEvent.actionName === "replaceMessage" && replaceable) onReplaceMessage?.(message);
        else if (nativeEvent.actionName === "claimMessage" && claimAction)
          onClaim?.(message, claimAction === "release");
        else if (nativeEvent.actionName.startsWith("answer") && choices && canTap) {
          const choice = choices[Number(nativeEvent.actionName.slice("answer".length))];
          if (choice !== undefined) onAnswer?.(message, choice);
        } else if (nativeEvent.actionName.startsWith("react_"))
          onReact?.(message, nativeEvent.actionName.slice("react_".length) as ReactionKind);
        else if (nativeEvent.actionName.startsWith("openLink")) {
          const link = links[Number(nativeEvent.actionName.slice("openLink".length))];
          if (link) openMessageLink(link.href);
        }
      }}
      onPress={replyable ? () => onReply(message) : undefined}
      style={[styles.row, own ? styles.own : styles.other, nested && styles.nested, selected && styles.selected]}
    >
      <View style={styles.head}>
        <Text style={[styles.author, own && { color: colors.accent }]} numberOfLines={1}>
          {who}
        </Text>
        {namesLine(message) ? (
          <Text style={styles.to} numberOfLines={1}>
            → {namesLine(message)}
          </Text>
        ) : null}
        <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
        {ticks.marks > 0 ? (
          <DeliveryTicks
            marks={ticks.marks}
            color={ticks.tone === "read" ? colors.accent : colors.muted}
            size={12}
            label={tickLabel(message.delivery)}
          />
        ) : null}
        {message.editedAt ? (
          <Text style={styles.edited} accessibilityLabel={`edited ${formatTime(message.editedAt)}`}>
            edited
          </Text>
        ) : null}
        {onEditMessage ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Edit message ${message.id}`}
            onPress={() => onEditMessage(message)}
            hitSlop={12}
          >
            <Text style={styles.linkAction}>Edit</Text>
          </Pressable>
        ) : null}
        {replaceable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Replace message ${message.id} with a new one`}
            onPress={() => onReplaceMessage?.(message)}
            hitSlop={12}
          >
            <Text style={styles.linkAction}>Replace</Text>
          </Pressable>
        ) : null}
        {claimAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              claimAction === "take"
                ? `Take message ${message.id}: tell everyone you are handling it`
                : `Release message ${message.id}`
            }
            onPress={() => onClaim?.(message, claimAction === "release")}
            hitSlop={12}
          >
            <Text style={styles.linkAction}>{claimLabel}</Text>
          </Pressable>
        ) : null}
        {onShareLink ? (
          // An explicit control: touch and hold stays free for selecting the text.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Copy or share link to message ${message.id}`}
            onPress={() => onShareLink(message)}
            hitSlop={12}
          >
            <Text style={styles.linkAction}>Link</Text>
          </Pressable>
        ) : null}
      </View>
      {message.replacedBy !== undefined ? (
        <Text style={styles.replacedNote}>Replaced by #{message.replacedBy}</Text>
      ) : null}
      {message.replaces !== undefined ? <Text style={styles.replacesNote}>Replaces #{message.replaces}</Text> : null}
      {message.claim ? (
        // The name is untrusted and drawn as plain text.
        <View style={styles.claimNote}>
          <Text style={styles.claimText}>{claimNote(message.claim, me)}</Text>
        </View>
      ) : null}
      {message.replyTo !== undefined ? (
        canLoadParent && onLoadParent ? (
          <Pressable
            accessibilityRole="link"
            accessibilityHint="Loads the message this replies to"
            onPress={() => onLoadParent(message.replyTo as number)}
            style={styles.quote}
            hitSlop={8}
          >
            <Text style={[styles.quoteText, styles.link]} numberOfLines={2}>
              {quoteText(message, quoted, parent)}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.quote}>
            <Text style={styles.quoteText} numberOfLines={2}>
              {quoteText(message, quoted, parent)}
            </Text>
          </View>
        )
      ) : null}
      {/* The inner view keeps its natural height, so it is measured even while clipped. */}
      <View
        style={[
          fold.maxHeight === null ? undefined : { maxHeight: fold.maxHeight, overflow: "hidden" },
          message.replacedBy !== undefined ? { opacity: 0.6 } : undefined,
        ]}
      >
        <View onLayout={onToggleFold ? (event) => setBodyHeight(event.nativeEvent.layout.height) : undefined}>
          {!message.text.trim() ? null : task ? (
            <Text style={styles.body}>
              Task <Text style={{ fontWeight: "700" }}>{task.body.task}</Text> · {task.body.action}
              {task.body.title ? ` · ${task.body.title}` : ""}
            </Text>
          ) : structured ? (
            <Text style={[styles.body, { fontFamily: mono, fontSize: 13 }]} numberOfLines={8}>
              {message.text}
            </Text>
          ) : (
            <MarkdownText text={message.text} blocks={tree ?? []} style={styles.body} />
          )}
        </View>
      </View>
      <Attachments files={message.attachments} origin={origin} token={token} />
      {fold.long && onToggleFold ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: fold.maxHeight === null }}
          onPress={() => onToggleFold(message.id)}
          style={styles.fold}
          hitSlop={8}
        >
          <Text style={styles.foldText}>{foldLabel}</Text>
        </Pressable>
      ) : null}
      {choices && mode ? (
        <View style={styles.choices}>
          {choices.map((choice) => {
            const chosen = mode === "answered" && message.answered?.choice === choice;
            return (
              <Pressable
                key={choice}
                accessibilityRole="button"
                accessibilityLabel={`Answer ${choice}`}
                accessibilityState={{ selected: chosen, disabled: !canTap, busy: answering }}
                disabled={!canTap}
                onPress={() => onAnswer?.(message, choice)}
                style={[styles.choice, mode === "open" && styles.choiceOpen, chosen && styles.choiceChosen]}
              >
                <Text style={[styles.choiceText, chosen && { color: colors.accent, fontWeight: "700" }]}>{choice}</Text>
              </Pressable>
            );
          })}
          <Text style={styles.choiceNote}>{choiceNote(message, mode)}</Text>
        </View>
      ) : null}
      {reacted.length || onReact ? (
        <View style={styles.reactions}>
          {REACTION_KINDS.map((kind) => {
            const names = message.reactions?.[kind] ?? [];
            if (!names.length && !onReact) return null;
            const mine = me !== undefined && names.includes(me);
            const { symbol, label } = REACTION_LABELS[kind];
            return (
              <Pressable
                key={kind}
                accessibilityRole="button"
                accessibilityState={{ selected: mine, disabled: !onReact }}
                accessibilityLabel={names.length ? `${label} ${names.length}: ${names.join(", ")}` : `React ${label.toLowerCase()}`}
                disabled={!onReact}
                onPress={() => onReact?.(message, kind)}
                hitSlop={4}
                style={[styles.chip, mine && styles.chipMine, !names.length && styles.chipEmpty]}
              >
                <Text style={[styles.chipText, mine && { color: colors.accent }]}>
                  {names.length ? `${symbol} ${names.length}` : symbol}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {receipts ? (
        <Text
          style={styles.receipts}
          accessibilityLabel={`${receipts}. ${RECEIPTS_MEANING}`}
        >
          {receipts}
        </Text>
      ) : null}
      {thread && onToggleThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: thread.open }}
          onPress={() => onToggleThread(message.id)}
          style={styles.toggle}
          hitSlop={8}
        >
          <Text style={styles.toggleText}>{threadLabel(thread.replies, thread.open, thread.unseen)}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export const MessageRow = memo(MessageRowImpl);

const styles = StyleSheet.create({
  row: {
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    maxWidth: "92%",
    minHeight: 44,
  },
  own: { alignSelf: "flex-end", backgroundColor: colors.own },
  other: { alignSelf: "flex-start", backgroundColor: colors.surface },
  selected: { borderWidth: 2, borderColor: colors.accent },
  head: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  author: { fontWeight: "700", fontSize: 14, flexShrink: 1 },
  to: { color: colors.warning, fontSize: 13, flexShrink: 1 },
  time: { color: colors.muted, fontSize: 12, marginLeft: "auto" },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: spacing.sm },
  quoteText: { color: colors.muted, fontSize: 13 },
  body: { fontSize: 16 },
  nested: { marginLeft: spacing.lg, borderLeftWidth: 2, borderLeftColor: colors.border },
  link: { color: colors.accent, textDecorationLine: "underline" },
  toggle: {
    alignSelf: "flex-start",
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  fold: { alignSelf: "flex-start", minHeight: 32, justifyContent: "center" },
  foldText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  receipts: { color: colors.muted, fontSize: 12 },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  choices: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  choice: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: spacing.md,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  choiceOpen: { borderColor: colors.accent },
  choiceChosen: { borderColor: colors.accent, borderWidth: 2 },
  choiceText: { fontSize: 15 },
  choiceNote: { color: colors.muted, fontSize: 12 },
  chip: {
    minHeight: 32,
    minWidth: 40,
    paddingHorizontal: spacing.sm,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipMine: { borderColor: colors.accent },
  chipEmpty: { opacity: 0.45, borderStyle: "dashed" },
  chipText: { color: colors.muted, fontSize: 13 },
  linkAction: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  edited: { color: colors.muted, fontSize: 12, fontStyle: "italic" },
  replacedNote: { color: colors.accent, fontSize: 12, fontWeight: "600", marginBottom: 2 },
  replacesNote: { color: colors.muted, fontSize: 12, marginBottom: 2 },
  claimNote: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    marginBottom: 4,
  },
  claimText: { color: colors.text, fontSize: 12, fontWeight: "600" },
});
