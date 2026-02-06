import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkExplainGate } from "../src/integrations/router/intent_gate.js";

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

const storageDir = tempDir("cg-intent-gate-");

const baseConfig = {
  policy: {
    enabled: true,
    default: { allow: [] },
    rules: [
      {
        name: "group_explain",
        match: { channel: "telegram", chat_type: "group" },
        allow: ["alerts.explain"],
        require: { mention_bot_for_explain: true, reply_required_for_explain: true },
      },
    ],
  },
  projects: {},
  meta: { policyOk: true, projectsCount: 0, errors: [] },
};

const gateMissingMention = checkExplainGate({
  storageDir,
  config: baseConfig as any,
  allowlistMode: "owner_only",
  ownerChatId: "owner_chat",
  ownerUserId: "owner_user",
  channel: "telegram",
  chatId: "group_chat",
  userId: "user_a",
  isGroup: true,
  mentionsBot: false,
  hasReply: true,
});
assert.equal(gateMissingMention.allowed, false, "missing mention should block");
assert.equal(gateMissingMention.block, "ignore", "missing mention should ignore");

const gateMissingReply = checkExplainGate({
  storageDir,
  config: baseConfig as any,
  allowlistMode: "owner_only",
  ownerChatId: "owner_chat",
  ownerUserId: "owner_user",
  channel: "telegram",
  chatId: "group_chat",
  userId: "user_a",
  isGroup: true,
  mentionsBot: true,
  hasReply: false,
});
assert.equal(gateMissingReply.allowed, false, "missing reply should block");
assert.equal(gateMissingReply.block, "reply", "missing reply should reply");

const gateAllowed = checkExplainGate({
  storageDir,
  config: baseConfig as any,
  allowlistMode: "owner_only",
  ownerChatId: "owner_chat",
  ownerUserId: "owner_user",
  channel: "telegram",
  chatId: "group_chat",
  userId: "user_a",
  isGroup: true,
  mentionsBot: true,
  hasReply: true,
});
assert.equal(gateAllowed.allowed, true, "group explain should allow when requirements met");

const privateAllowed = checkExplainGate({
  storageDir,
  config: baseConfig as any,
  allowlistMode: "owner_only",
  ownerChatId: "owner_chat",
  ownerUserId: "owner_user",
  channel: "telegram",
  chatId: "owner_chat",
  userId: "owner_user",
  isGroup: false,
  mentionsBot: false,
  hasReply: true,
});
assert.equal(privateAllowed.allowed, true, "owner private should be allowed");

const privateDenied = checkExplainGate({
  storageDir,
  config: baseConfig as any,
  allowlistMode: "owner_only",
  ownerChatId: "owner_chat",
  ownerUserId: "owner_user",
  channel: "telegram",
  chatId: "someone_else",
  userId: "someone_else",
  isGroup: false,
  mentionsBot: false,
  hasReply: true,
});
assert.equal(privateDenied.allowed, false, "non-owner private should be denied");

console.log("intent_gate.test.ts: ok");
