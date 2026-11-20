/**
 * Message text as safe Markdown (ADR 0043). The tree from core/markdown.ts is drawn with
 * nested <Text> and <View> only: there is no HTML or web view, and a link opens only when its
 * target is http or https.
 */
import { Fragment, memo, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, type StyleProp, type TextStyle, View } from "react-native";
import { type Block, type Inline, parse, safeHref } from "../core/markdown.ts";
import { colors, mono, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

/** Opens a link from a message, checked again so nothing but http(s) ever reaches Linking. */
export function openMessageLink(href: string): void {
  const safe = safeHref(href);
  if (safe) Linking.openURL(safe).catch(() => {});
}

function inline(nodes: Inline[], key = "i"): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}.${index}`;
    switch (node.type) {
      case "text":
        return <Fragment key={k}>{node.text}</Fragment>;
      case "code":
        return (
          <Text key={k} style={styles.code}>
            {node.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={k} style={styles.strong}>
            {inline(node.children, k)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} style={styles.em}>
            {inline(node.children, k)}
          </Text>
        );
      case "del":
        return (
          <Text key={k} style={styles.del}>
            {inline(node.children, k)}
          </Text>
        );
      case "link":
        return (
          <Text
            key={k}
            style={styles.link}
            accessibilityRole="link"
            accessibilityHint={`Opens ${node.href}`}
            onPress={() => openMessageLink(node.href)}
          >
            {inline(node.children, k)}
          </Text>
        );
    }
  });
}

function blocks(list: Block[], base: StyleProp<TextStyle>, key = "b"): ReactNode[] {
  return list.map((block, index) => {
    const k = `${key}.${index}`;
    switch (block.type) {
      case "paragraph":
        return (
          <Text key={k} style={base} selectable>
            {inline(block.children)}
          </Text>
        );
      case "heading":
        return (
          <Text
            key={k}
            accessibilityRole="header"
            style={[base, styles.heading, block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : null]}
            selectable
          >
            {inline(block.children)}
          </Text>
        );
      case "code_block":
        // Long lines scroll sideways instead of wrapping.
        return (
          <ScrollView key={k} horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
            <Text style={styles.codeText} selectable>
              {block.text}
            </Text>
          </ScrollView>
        );
      case "quote":
        return (
          <View key={k} style={styles.quote}>
            {blocks(block.children, [base, styles.quoteText], k)}
          </View>
        );
      case "list":
        return (
          <View key={k} style={styles.list}>
            {block.items.map((item, n) => (
              <View key={`${k}.${n}`} style={styles.item}>
                <Text style={[base, styles.marker]}>{block.ordered ? `${(block.start ?? 1) + n}.` : "•"}</Text>
                <View style={styles.itemBody}>{blocks(item, base, `${k}.${n}`)}</View>
              </View>
            ))}
          </View>
        );
      case "table":
        return (
          <ScrollView key={k} horizontal style={styles.table}>
            <View>
              {[block.head, ...block.rows].map((row, r) => (
                <View key={`${k}.${r}`} style={[styles.row, r === 0 && styles.headRow]}>
                  {row.map((cell, c) => (
                    <Text
                      key={`${k}.${r}.${c}`}
                      style={[
                        styles.cell,
                        r === 0 && styles.strong,
                        { textAlign: block.align[c] === "" ? "left" : block.align[c] },
                      ]}
                    >
                      {inline(cell)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
    }
  });
}

type Props = { text: string; style?: StyleProp<TextStyle> };

function MarkdownTextImpl({ text, style }: Props) {
  const tree = useMemo(() => parse(text), [text]);
  // One paragraph (all plain text is one) stays a single selectable <Text>, as before.
  if (tree.length === 0 || (tree.length === 1 && tree[0].type === "paragraph"))
    return (
      <Text style={style} selectable>
        {tree.length ? inline(tree[0].type === "paragraph" ? tree[0].children : []) : text}
      </Text>
    );
  return <View style={styles.stack}>{blocks(tree, style)}</View>;
}

export const MarkdownText = memo(MarkdownTextImpl);

const styles = StyleSheet.create({
  stack: { gap: spacing.xs },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  code: { fontFamily: mono, fontSize: 14, backgroundColor: colors.surfaceRaised },
  heading: { fontWeight: "700" },
  h1: { fontSize: 20 },
  h2: { fontSize: 18 },
  codeBlock: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  codeContent: { padding: spacing.sm },
  codeText: { fontFamily: mono, fontSize: 13 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: spacing.sm, gap: spacing.xs },
  quoteText: { color: colors.muted },
  list: { gap: 2 },
  item: { flexDirection: "row", gap: spacing.xs },
  marker: { minWidth: 18 },
  itemBody: { flex: 1, gap: 2 },
  table: { borderRadius: radius.sm },
  row: { flexDirection: "row" },
  headRow: { backgroundColor: colors.surfaceRaised },
  cell: {
    minWidth: 72,
    maxWidth: 240,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    fontSize: 14,
  },
});
