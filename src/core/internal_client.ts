function resolveBaseUrl(): string {
  return process.env.CHAT_GATEWAY_INTERNAL_URL || "http://127.0.0.1:8787";
}

export async function submitTask(payload: {
  task_id: string;
  stage: "analyze" | "suggest";
  prompt: string;
  context?: any;
}) {
  const base = resolveBaseUrl();
  const token = process.env.CHAT_GATEWAY_TOKEN;
  if (!token) throw new Error("Missing CHAT_GATEWAY_TOKEN");

  const res = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gateway_http_${res.status}: ${text}`);
  }

  return res.json();
}
