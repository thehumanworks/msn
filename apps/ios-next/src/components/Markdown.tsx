import { Fragment, memo, useMemo } from "react";
import { Alert, Linking, type ColorValue, ScrollView, StyleSheet, Text, View } from "react-native";
import { type Block, type Inline, parseMarkdown, safeHref } from "../lib/shared.ts";

const MONO = "Menlo";

function inlines(nodes: Inline[], tint: ColorValue, key = ""): React.ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}${index}`;
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
          <Text key={k} style={{ fontWeight: "700" }}>
            {inlines(node.children, tint, `${k}.`)}
          </Text>
        );
      case "em":
        return (
          <Text key={k} style={{ fontStyle: "italic" }}>
            {inlines(node.children, tint, `${k}.`)}
          </Text>
        );
      case "del":
        return (
          <Text key={k} style={{ textDecorationLine: "line-through" }}>
            {inlines(node.children, tint, `${k}.`)}
          </Text>
        );
      case "link": {
        const href = safeHref(node.href);
        return (
          <Text
            key={k}
            style={{ color: tint, textDecorationLine: "underline" }}
            onPress={
              href ? () => void Linking.openURL(href).catch(() => Alert.alert("Can't open link", href)) : undefined
            }
            accessibilityRole="link"
          >
            {inlines(node.children, tint, `${k}.`)}
          </Text>
        );
      }
    }
  });
}

function blocks(list: Block[], textColor: ColorValue, tint: ColorValue, key = ""): React.ReactNode[] {
  return list.map((block, index) => {
    const k = `${key}${index}`;
    switch (block.type) {
      case "paragraph":
        return (
          <Text key={k} style={[styles.text, { color: textColor }]}>
            {inlines(block.children, tint)}
          </Text>
        );
      case "heading":
        return (
          <Text
            key={k}
            style={[styles.text, styles.heading, { color: textColor, fontSize: block.level <= 2 ? 19 : 17 }]}
          >
            {inlines(block.children, tint)}
          </Text>
        );
      case "code_block":
        return (
          <ScrollView key={k} horizontal style={styles.pre} contentContainerStyle={{ padding: 10 }}>
            <Text style={[styles.preText, { color: textColor }]} selectable>
              {block.text.replace(/\n$/, "")}
            </Text>
          </ScrollView>
        );
      case "quote":
        return (
          <View key={k} style={styles.quote}>
            {blocks(block.children, textColor, tint, `${k}.`)}
          </View>
        );
      case "list":
        return (
          <View key={k} style={{ gap: 2 }}>
            {block.items.map((item, i) => (
              <View key={`${k}.${i}`} style={{ flexDirection: "row", gap: 6 }}>
                <Text style={[styles.text, { color: textColor }]}>
                  {block.ordered ? `${(block.start ?? 1) + i}.` : "•"}
                </Text>
                <View style={{ flex: 1, gap: 4 }}>{blocks(item, textColor, tint, `${k}.${i}.`)}</View>
              </View>
            ))}
          </View>
        );
      case "table":
        return (
          <ScrollView key={k} horizontal>
            <View style={styles.table}>
              {[block.head, ...block.rows].map((row, r) => (
                <View key={`${k}.${r}`} style={{ flexDirection: "row" }}>
                  {row.map((cell, c) => (
                    <Text key={c} style={[styles.cell, { color: textColor }, r === 0 && { fontWeight: "700" }]}>
                      {inlines(cell, tint)}
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

/** Safe Markdown (ADR 0043), parsed by the shared core; links open only http(s) and mailto. */
export const Markdown = memo(function Markdown({
  text,
  color,
  tint,
}: {
  text: string;
  color: ColorValue;
  tint: ColorValue;
}) {
  const parsed = useMemo(() => parseMarkdown(text), [text]);
  return <View style={{ gap: 6 }}>{blocks(parsed, color, tint)}</View>;
});

const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 22 },
  heading: { fontWeight: "700" },
  code: { fontFamily: MONO, fontSize: 14 },
  pre: { backgroundColor: "rgba(127,127,127,0.16)", borderRadius: 10 },
  preText: { fontFamily: MONO, fontSize: 13, lineHeight: 18 },
  quote: { borderLeftWidth: 3, borderLeftColor: "rgba(127,127,127,0.5)", paddingLeft: 10, gap: 4 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(127,127,127,0.5)", borderRadius: 6 },
  cell: { padding: 6, minWidth: 70, fontSize: 14 },
});
