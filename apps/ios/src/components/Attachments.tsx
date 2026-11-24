import { useState } from "react";
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { Attachment } from "../core/types.ts";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A root-relative path, or an https URL on the same origin. Anything else is not opened. */
function absolute(origin: string, path: string): string | null {
  const base = origin.replace(/\/$/, "");
  if (path.startsWith("/") && !path.startsWith("//")) return `${base}${path}`;
  try {
    const url = new URL(path);
    const home = new URL(base);
    if (url.protocol === "https:" && url.origin === home.origin) return url.toString();
  } catch {
    return null;
  }
  return null;
}

/** Signed links last about ten minutes. Use the channel key once that window is close. */
function signedStillFresh(url: string, origin: string): boolean {
  try {
    const exp = new URL(url, origin).searchParams.get("exp");
    if (!exp) return true;
    const at = Number(exp);
    return Number.isFinite(at) && at - Date.now() > 60_000;
  } catch {
    return false;
  }
}

/**
 * Inline image preview (tap for the full frame) and a chip with the name and size for every
 * other file. Images load from the short-lived signed URL. Other files open that download URL.
 */
export function Attachments({
  files,
  origin,
  token,
}: {
  files: Attachment[] | undefined;
  origin: string;
  token?: string;
}) {
  const [full, setFull] = useState<string | null>(null);
  const [retried, setRetried] = useState<Record<string, boolean>>({});
  if (!files?.length) return null;
  return (
    <View style={styles.list}>
      {files.map((file) => {
        const mime = file.mime || file.mediaType;
        const previewPath = file.previewUrl && INLINE.has(mime) ? absolute(origin, file.previewUrl) : null;
        const stable = file.url ? absolute(origin, file.url) : null;
        const authed = Boolean(token && stable);
        const preview =
          previewPath && signedStillFresh(previewPath, origin) && !retried[file.id] ? previewPath : authed ? stable : previewPath;
        const download = (file.downloadUrl ? absolute(origin, file.downloadUrl) : null) ?? stable;
        const bearer = token && preview === stable ? { Authorization: `Bearer ${token}` } : undefined;
        return (
          <View key={`${file.index}-${file.id}`} style={styles.item}>
            {preview ? (
              <Pressable onPress={() => setFull(preview)} accessibilityRole="imagebutton" accessibilityLabel={file.name}>
                <Image
                  source={bearer ? { uri: preview, headers: bearer } : { uri: preview }}
                  style={[styles.preview, file.width && file.height ? { aspectRatio: file.width / file.height } : null]}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                  onError={() => {
                    if (retried[file.id] || !authed) return;
                    setRetried((current) => ({ ...current, [file.id]: true }));
                  }}
                />
              </Pressable>
            ) : null}
            <Pressable
              style={styles.chip}
              accessibilityRole="button"
              accessibilityLabel={`${preview ? "View" : "Download"} ${file.name}, ${sizeLabel(file.size ?? file.bytes)}`}
              onPress={() => {
                if (preview) setFull(preview);
                else if (download) void Linking.openURL(download);
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
          {full ? (
            <Image
              source={
                token && !full.includes("sig=")
                  ? { uri: full, headers: { Authorization: `Bearer ${token}` } }
                  : { uri: full }
              }
              style={styles.full}
              resizeMode="contain"
            />
          ) : null}
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
