import assert from "node:assert/strict";
import { resolveExplicitIntent } from "../src/integrations/router/intent_registry.js";

const explain = resolveExplicitIntent("解释一下");
assert.equal(explain?.kind, "alert_explain", "should detect explain intent");

const summary = resolveExplicitIntent("摘要 200");
assert.equal(summary?.kind, "news_summary", "should detect summary intent");

const none = resolveExplicitIntent("随便聊聊");
assert.equal(none, null, "should ignore unrelated text");

console.log("intent_registry.test.ts: ok");
