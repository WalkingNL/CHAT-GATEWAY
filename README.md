## Networking note
Telegram channel uses system `curl -4` for stability on this host.
Node fetch/undici is intentionally not used.

# CHAT-GATEWAY

## Gateway-only mode
Run the internal API without Telegram/Feishu integrations:

```bash
export CHAT_GATEWAY_TOKEN="your-token"
export DEEPSEEK_API_KEY="your-deepseek-key"
npx tsx src/gateway/index.ts
```
