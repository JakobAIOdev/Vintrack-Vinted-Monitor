#!/usr/bin/env sh
# Registers this instance's Telegram webhook and verifies it. The bot token and
# webhook secret are read inside the container, so they never appear in command
# arguments or shell history.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

docker compose exec -T control-center node --input-type=module <<'NODE'
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, AUTH_URL: origin } = process.env;
if (!token || !secret || !origin?.startsWith("https://")) {
  console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an HTTPS AUTH_URL in .env,");
  console.error("then recreate the services: docker compose up -d --force-recreate control-center worker");
  process.exit(1);
}
const target = new URL("/api/telegram/webhook", origin).href;
async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", body,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed; check the bot settings.`);
  return data.result;
}
await call("setWebhook", new URLSearchParams({ url: target, secret_token: secret }));
const info = await call("getWebhookInfo");
if (info.url !== target) throw new Error("Telegram webhook URL does not match AUTH_URL.");
console.log("Webhook registered:", info.url);
console.log("Pending updates:", info.pending_update_count);
NODE
