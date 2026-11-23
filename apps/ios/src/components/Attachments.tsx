import { useState } from "react";
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { Attachment } from "../core/types.ts";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function absolute(origin: string, path: string): string {
  if (path.startsWith("https://") || path.startsWith("http://")) return path;
  return `${origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Inline image preview (tap for the full frame) and a chip with the name and size for every
 * other file. Images load from the short-lived signed URL. Other files open that download URL.
 */
export function Attachments({ files, origin }: { files: Attachment[] | undefined; origin: string }) {
  const [full, setFull] = useState<string | null>(null);
  if (!files?.length) return null;
  return (
    <View style={styles.list}>
      {files.map((file) => {
        const mime = file.mime || file.mediaType;
        const preview = file.previewUrl && INLINE.has(mime) ? absolute(origin, file.previewUrl) : null;
        const download = file.downloadUrl ?? file.url;
        return (
          <View key={`${file.index}-${file.id}`} style={styles.item}>
            {preview ? (
              <Pressable onPress={() => setFull(preview)} accessibilityRole="imagebutton" accessibilityLabel={file.name}>
                <Image
                  source={{ uri: preview }}
                  style={[styles.preview, file.width && file.height ? { aspectRatio: file.width / file.height } : null]}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                />
              </Pressable>
            ) : null}
            <Pressable
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={`${preview ? "View" : "Download"} ${file.name}, ${sizeLabel(file.size ?? file.bytes)}`}
              onPress={() => {
                if (preview) setFull(preview);
                else if (download) void Linking.openURL(absolute(origin, download));
              }}
            >
              <Text style={styles.chipText} numberOfLines={2}>
                {file.name} · {sizeLabel(file.size ?? file.bytes)}
              </Text>
            </Pressable>
          </View>
        );
      })}
      <Modal visible={full !== null} transparent animationType="fade" onRequestClose={() => setFull(null)}>
        <Pressable style={styles.backdrop} onPress={() => setFull(null)} accessibilityLabel="Close image">
          {full ? <Image source={{ uri: full }} style={styles.full} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, marginTop: 6 },
  item: { gap: 4, maxWidth: "100%" },
  preview: { width: 220, maxHeight: 180, borderRadius: 8, backgroundColor: "rgba(127,127,127,0.15)" },
  chip: {
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(127,127,127,0.45)",
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.82)", alignItems: "center", justifyContent: "center" },
  full: { width: "92%", height: "80%" },
});
