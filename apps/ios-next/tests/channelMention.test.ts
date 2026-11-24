import assert from "node:assert/strict";
import { test } from "node:test";
import { channelMentionNotice, splitChannelMentions } from "../../ios/src/core/mention.ts";

// ios-next highlights with the same splitter, and refuses a send with the same ChannelController
// sentence, as apps/ios. These edges are the ones the server scan agrees with.
test("ios-next uses the same @channel edges and refusal wording as apps/ios", () => {
  assert.equal(splitChannelMentions("**@channel**").some((part) => part.text === "@channel"), true);
  assert.equal(splitChannelMentions("_@channel_").some((part) => part.text === "@channel"), true);
  assert.equal(splitChannelMentions("``@channel`").some((part) => part.text === "@channel"), true);
  assert.deepEqual(splitChannelMentions("İ@channel"), [{ text: "İ@channel", channel: false }]);
  assert.equal(splitChannelMentions("snake_@channel").some((part) => part.channel), false);
  assert.equal(splitChannelMentions("a*@channel").some((part) => part.channel), false);
  assert.equal(splitChannelMentions("   ```\n@channel\n   ```\n").some((part) => part.channel), false);
  assert.match(channelMentionNotice({ code: "channel_mention_limited", message: "throttled" }) ?? "", /throttled/);
  assert.match(
    channelMentionNotice({ code: "channel_mention_limited" }) ?? "",
    /Only the owner can use it again that soon/,
  );
  assert.match(
    channelMentionNotice({ code: "channel_mention_capped" }) ?? "",
    /@channel can notify at most 32 people besides you/,
  );
  assert.equal(channelMentionNotice({ code: "other", message: "no" }), null);
});
