// The API layer, sync engine and keychain profile storage are shared with apps/ios, where they
// are covered by its Node tests. Nothing here is forked: this file only re-exports what the
// screens of this app use. Metro resolves every bare import in those files from this app.
export { AppModel, type AppPhase } from "../../../ios/src/core/appModel.ts";
export { ChannelController, type ChannelState, type OutboxItem } from "../../../ios/src/core/channelController.ts";
export { ChannelListController, type ChannelListState } from "../../../ios/src/core/channelList.ts";
export type { ConnectionState, SessionController } from "../../../ios/src/core/sessionController.ts";
export type { ProfileSummary } from "../../../ios/src/core/profileStorage.ts";
export type { SecretStore } from "../../../ios/src/core/sessionStorage.ts";
export type { ChannelSummary, Message } from "../../../ios/src/core/types.ts";
export { currentUnread, seenMark, unreadBadge } from "../../../ios/src/core/readMarks.ts";
export { parse as parseMarkdown, safeHref, type Block, type Inline } from "../../../ios/src/core/markdown.ts";
export { messageLink } from "../../../ios/src/core/links.ts";
export { useStore } from "../../../ios/src/hooks/useStore.ts";
export { useOwned } from "../../../ios/src/hooks/useOwned.ts";
export { useChannel, useChannelList } from "../../../ios/src/hooks/useChannelController.ts";
export { validateOrigin } from "../../../ios/src/core/httpClient.ts";
