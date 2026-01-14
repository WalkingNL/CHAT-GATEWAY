# Feishu Webhook Setup Notes (Postmortem)

This document records why the Feishu group chat integration did not respond and the exact traps we hit.

## Root causes we hit

- Callback URL used port 80 implicitly while the service only listened on 8787, so Feishu timed out.
- External traffic to 8787 was blocked at the cloud firewall, even though local curl worked.
- Nginx default site returned 404 because no reverse-proxy location existed for `/feishu/events`.
- HTTPS returned 405 because the 443 server block was not configured (80-only config existed).
- Domain `crypto-agent.com` DNS was not under our control; NS pointed to Afternic, so changes in DNSPod never took effect.
- Feishu console performs a real callback test; local curl success is not sufficient to pass.

## Quick validation checklist

- `channels.feishu.enabled: true`
- `gateway.owner.feishu_chat_id` is set (non-empty)
- `config/policy.yml` includes `channel: feishu` rules for DM/group
- Event subscription: `im.message.receive_v1` enabled, encryption disabled for now
- External callback reachable from Feishu within 3 seconds

## Known pitfalls and how to detect them

- GET `/feishu/events` returns `401 unauthorized`:
  - You hit the internal API (no Feishu handler registered) or used GET. Use POST with JSON.
- POST works on `127.0.0.1` but not from outside:
  - Cloud firewall or security group is blocking the port.
- Nginx returns 404:
  - Missing `location /feishu/events` reverse proxy.
- HTTPS returns 405:
  - Missing `location /feishu/events` inside the 443 server block.
- Feishu console still times out:
  - Feishu cannot reach the endpoint. Check firewall and DNS, and ensure HTTPS if required.

## Minimal test request (POST)

```
curl -i -X POST http://<host>:<port>/feishu/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"x","token":"<FEISHU_VERIFICATION_TOKEN>"}'
```

Expected response:

```
HTTP/1.1 200
{"challenge":"x"}
```

## DNS gotchas we hit

- `crypto-agent.com` was delegated to `NS1.AFTERNIC.COM / NS2.AFTERNIC.COM`.
  - DNSPod changes never applied.
  - Fix is to update NS at the registrar or edit A records in the actual DNS host (GoDaddy/Afternic).

## Nginx reverse proxy (HTTP, port 80)

```
location /feishu/events {
  proxy_pass http://127.0.0.1:8787/feishu/events;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## HTTPS notes

- Feishu may refuse plain HTTP in console validation.
- HTTPS requires a real domain + valid certificate (Let’s Encrypt).
- If using HTTPS, ensure the 443 server block has the same proxy location.
