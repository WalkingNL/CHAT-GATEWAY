import assert from "node:assert/strict";
import { buildIntentHints } from "../src/integrations/router/intent_hints.js";

process.env.TELEGRAM_BOT_USERNAME = "SoliaNLBot";

function hint(input: Partial<Parameters<typeof buildIntentHints>[0]> & { text: string }) {
  return buildIntentHints({
    channel: "telegram",
    isGroup: false,
    mentionsBot: false,
    replyToId: "",
    ...input,
  });
}

const privateExplain = hint({ text: "解释一下" });
assert.equal(privateExplain.explainRequested, true, "private explain should be explicit");
assert.equal(privateExplain.summaryRequested, false, "private explain should not be summary");
assert.equal(privateExplain.allowResolve, false, "private explain should skip resolve");

const privateSummary = hint({ text: "摘要 200" });
assert.equal(privateSummary.summaryRequested, true, "summary keyword should be detected");
assert.equal(privateSummary.allowResolve, false, "summary should skip resolve");

const groupExplain = hint({
  text: "@SoliaNLBot 解释一下",
  isGroup: true,
  mentionsBot: true,
  replyToId: "123",
});
assert.equal(groupExplain.cleanedText, "解释一下", "mention should be stripped");
assert.equal(groupExplain.explainRequested, true, "group explain should be explicit");

const groupNoReply = hint({
  text: "@SoliaNLBot 帮我看看",
  isGroup: true,
  mentionsBot: true,
  replyToId: "",
});
assert.equal(groupNoReply.allowResolve, true, "group with mention should allow resolve");

const groupWithReply = hint({
  text: "@SoliaNLBot 帮我看看",
  isGroup: true,
  mentionsBot: true,
  replyToId: "456",
});
assert.equal(groupWithReply.allowResolve, true, "group with reply should allow resolve");

const groupNoMention = hint({
  text: "解释一下",
  isGroup: true,
  mentionsBot: false,
  replyToId: "789",
});
assert.equal(groupNoMention.allowResolve, false, "group without mention should skip resolve");

const privateFeedback = hint({ text: "反馈 告警太多" });
assert.equal(privateFeedback.allowResolve, true, "feedback prefix should allow resolve in private");

console.log("intent_hints.test.ts: ok");
