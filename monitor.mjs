#!/usr/bin/env node
/**
 * THE OUTSIDE MONITOR, scheduled in a separate repository so it runs on GitHub's machines,
 * not on the server it watches (docs/operations/RELIABILITY.md §2). No dependencies.
 *
 *   MONITOR_TARGETS='[{"name":"staging web","url":"https://user:pw@host/api/health","expect":"health"},
 *                     {"name":"production site","url":"https://example.com/","expect":"200"}]'
 *   ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/…   node monitor.mjs state.json
 *
 * expect "health": 200 with {"status":"ok"} (the FPT /api/health); expect "200": any 200.
 * https targets also need a certificate with 14 or more days left.
 * The state file (kept between runs by the workflow's cache) makes alerts transitions only:
 * DOWN after FAIL_AFTER failing runs in a row, BACK on the first passing run, a reminder every
 * REMIND_HOURS while down, and one "alive" post a day after DAILY_HOUR UTC.
 * Logs name targets only: URLs and credentials are secrets and never printed (a public
 * repository's logs are public). MONITOR_SIMULATE_DOWN=<name> fails that target, for tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";

const TIMEOUT_MS = 15_000;
const CERT_MIN_DAYS = 14;
const FAIL_AFTER = Number(process.env.MONITOR_FAIL_AFTER) || 2;
const REMIND_HOURS = 6;
const DAILY_HOUR = 8;

async function probe(target) {
  if (process.env.MONITOR_SIMULATE_DOWN === target.name) return { ok: false, why: "simulated failure (test run)" };
  const url = new URL(target.url);
  const headers = {};
  if (url.username) headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  url.username = url.password = "";
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - started;
    if (res.status === 401) return { ok: false, why: "401: the monitor's credentials are wrong (fix the secret, not the site)" };
    if (target.expect === "health") {
      const body = await res.json().catch(() => null);
      if (res.status === 503 && body?.database === "unreachable") return { ok: false, why: "503: the site is up but cannot reach its database" };
      if (res.status !== 200 || body?.status !== "ok") return { ok: false, why: `HTTP ${res.status}: up but unhealthy, or the proxy is failing` };
      return { ok: true, why: `200 in ${ms} ms, database ${body.database}` };
    }
    await res.arrayBuffer().catch(() => null);
    return res.status === 200 ? { ok: true, why: `200 in ${ms} ms` } : { ok: false, why: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, why: error?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : `unreachable (${error?.cause?.code ?? error?.name ?? "error"})` };
  }
}

function certificate(target) {
  const { hostname, port, protocol } = new URL(target.url);
  if (protocol !== "https:") return Promise.resolve({ ok: true, why: "" });
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname, timeout: TIMEOUT_MS }, () => {
      const days = Math.floor((new Date(socket.getPeerCertificate().valid_to).getTime() - Date.now()) / 86_400_000);
      socket.end();
      resolve(days >= CERT_MIN_DAYS ? { ok: true, why: `, certificate ${days} days` } : { ok: false, why: `certificate expires in ${days} days (renewal failed: check Coolify's proxy and port 80)` });
    });
    socket.on("timeout", () => socket.destroy(new Error("timeout")));
    socket.on("error", (e) => resolve({ ok: false, why: `TLS failed (${e.code ?? e.message})` }));
  });
}

async function post(webhook, content) {
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900), username: "FPT Outside Monitor" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => console.log("alert post FAILED"));
}

async function main() {
  const statePath = process.argv[2] ?? "state.json";
  const targets = JSON.parse(process.env.MONITOR_TARGETS ?? "[]");
  const webhook = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
  if (!targets.length) throw new Error("MONITOR_TARGETS is empty");
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { console.log("no previous state (first run, or the cache expired)"); }
  const now = Date.now();
  const lines = [];
  for (const t of targets) {
    const health = await probe(t);
    const cert = health.ok ? await certificate(t) : { ok: true, why: "" };
    const ok = health.ok && cert.ok;
    const why = ok ? health.why + cert.why : health.ok ? cert.why : health.why;
    const s = (state[t.name] ??= { down: false, fails: 0, since: now, remindedAt: now });
    s.fails = ok ? 0 : s.fails + 1;
    console.log(`${t.name}: ${ok ? "PASS" : `FAIL (${s.fails} in a row)`} ${why}`);
    if (!ok && !s.down && s.fails >= FAIL_AFTER) {
      Object.assign(s, { down: true, since: now, remindedAt: now });
      await post(webhook, `🔴 **${t.name}** is DOWN from outside the server: ${why}. Seen ${s.fails} checks in a row. Runbook: docs/operations/RELIABILITY.md §2.`);
    } else if (ok && s.down) {
      await post(webhook, `✅ **${t.name}** is back (${why}); it was down about ${Math.round((now - s.since) / 60_000)} min.`);
      Object.assign(s, { down: false, since: now });
    } else if (s.down && now - s.remindedAt >= REMIND_HOURS * 3_600_000) {
      s.remindedAt = now;
      await post(webhook, `🔴 **${t.name}** is still DOWN after ${Math.round((now - s.since) / 3_600_000)} h: ${why}`);
    }
    lines.push(`${t.name} ${s.down ? "DOWN" : "ok"}`);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  if (new Date(now).getUTCHours() >= DAILY_HOUR && state._daily !== today) {
    state._daily = today;
    await post(webhook, `outside monitor daily: ${lines.join(", ")} (checked every 10 min from GitHub; no daily post means the monitor stopped)`);
  }
  writeFileSync(statePath, JSON.stringify(state));
}

main().catch((e) => { console.log(`monitor error: ${e.message}`); process.exitCode = 1; });
