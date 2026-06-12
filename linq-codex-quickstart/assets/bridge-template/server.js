const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner/v3";
const DEFAULT_WEBHOOK_EVENTS = [
  "message.sent",
  "message.received",
  "message.delivered",
  "message.read",
  "message.failed",
];
const DEFAULT_WEBHOOK_VERSION = "2026-02-03";
const MAX_BODY_BYTES = 1_000_000;
const MAX_PROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;
const processedWebhookEvents = new Set();

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function hasLink(text) {
  return /\bhttps?:\/\/|\bwww\./i.test(text);
}

function numberKey(handle) {
  return String(handle || "").replace(/\D/g, "");
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n\n[truncated by bridge]`;
}

function firstMessageInput(overrides = {}) {
  const text = overrides.text || env("LINQ_FIRST_MESSAGE", "Hello from Linq!");
  if (hasLink(text)) {
    throw new Error("The first outbound Linq message cannot contain links.");
  }

  return {
    from: overrides.from || requireEnv("LINQ_FROM_NUMBER"),
    to: overrides.to || requireEnv("LINQ_TO_NUMBER"),
    text,
    idempotencyKey:
      overrides.idempotency_key ||
      overrides.idempotencyKey ||
      `linq-starter-${crypto.randomUUID()}`,
  };
}

async function linqRequest(apiPath, options = {}) {
  const response = await fetch(`${LINQ_API_BASE_URL}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${requireEnv("LINQ_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      body?.message ||
      body?.error ||
      `Linq API request failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = body;
    throw error;
  }

  return body;
}

function sendFirstMessage(input = {}) {
  const message = firstMessageInput(input);
  return linqRequest("/chats", {
    method: "POST",
    body: {
      from: message.from,
      to: [message.to],
      message: {
        parts: [{ type: "text", value: message.text }],
        idempotency_key: message.idempotencyKey,
      },
    },
  });
}

function listPhoneNumbers() {
  return linqRequest("/phone_numbers");
}

function sendChatMessage(chatId, text, options = {}) {
  const message = {
    parts: [
      {
        type: "text",
        value: truncateText(text, Number(env("LINQ_REPLY_MAX_CHARS", "9000"))),
      },
    ],
    idempotency_key:
      options.idempotencyKey ||
      `linq-codex-${options.eventId || crypto.randomUUID()}`,
  };

  if (options.replyToMessageId) {
    message.reply_to = { message_id: options.replyToMessageId, part_index: 0 };
  }

  return linqRequest(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: { message },
  });
}

function setTyping(chatId, isTyping) {
  return linqRequest(`/chats/${encodeURIComponent(chatId)}/typing`, {
    method: isTyping ? "POST" : "DELETE",
  }).catch((error) => {
    console.warn("Typing indicator update failed:", error.message);
  });
}

function webhookTargetUrl(targetUrl = requireEnv("PUBLIC_WEBHOOK_URL")) {
  const url = new URL(targetUrl);
  if (!url.searchParams.has("version")) {
    url.searchParams.set("version", DEFAULT_WEBHOOK_VERSION);
  }
  return url.toString();
}

function createWebhookSubscription(input = {}) {
  const body = {
    target_url: webhookTargetUrl(input.target_url),
    subscribed_events: input.subscribed_events || DEFAULT_WEBHOOK_EVENTS,
  };

  const phoneNumber = input.phone_number || env("LINQ_FROM_NUMBER");
  if (phoneNumber) {
    body.phone_numbers = [phoneNumber];
  }

  return linqRequest("/webhook-subscriptions", { method: "POST", body });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseJsonBody(rawBody) {
  if (!rawBody.length) return {};
  return JSON.parse(rawBody.toString("utf8"));
}

function verifyWebhookSignature(secret, rawBody, headers) {
  const eventId = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"];
  if (!eventId || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  const ageSeconds = Math.abs(Date.now() / 1000 - sentAt);
  if (!Number.isFinite(sentAt) || ageSeconds > 5 * 60) return false;

  const secretValue = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(secretValue, "base64");
  const signedContent = Buffer.concat([
    Buffer.from(`${eventId}.${timestamp}.`, "utf8"),
    rawBody,
  ]);
  const expected = crypto
    .createHmac("sha256", key)
    .update(signedContent)
    .digest();

  return signature.split(/\s+/).some((candidate) => {
    if (!candidate.startsWith("v1,")) return false;
    const actual = Buffer.from(candidate.slice(3), "base64");
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  });
}

function summarizeWebhook(event) {
  return {
    event_id: event.event_id || event.id,
    type: event.event_type || event.type,
    chat_id: event.chat_id || event.data?.chat_id || event.data?.chat?.id,
    message_id:
      event.message_id ||
      event.data?.message_id ||
      event.data?.message?.id ||
      event.data?.id,
  };
}

function messageParts(data) {
  return data.parts || data.message?.parts || [];
}

function textFromParts(parts) {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "link") return part.value;
      if (part.type === "media") {
        return `[media: ${part.filename || part.url || part.attachment_id || "attachment"}]`;
      }
      return part.type ? `[${part.type} part]` : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function inboundMessageFromWebhook(event) {
  if ((event.event_type || event.type) !== "message.received") return null;

  const data = event.data || event;
  const direction =
    data.direction ||
    (data.is_from_me === false ? "inbound" : undefined) ||
    (data.is_from_me === true ? "outbound" : undefined);
  if (direction && direction !== "inbound") return null;

  const sender =
    data.sender_handle?.handle ||
    data.from_handle?.handle ||
    data.from ||
    data.sender_phone;
  const allowedSender = env("LINQ_ALLOWED_SENDER");
  if (allowedSender && numberKey(sender) !== numberKey(allowedSender)) {
    console.log("Ignoring message from non-allowed sender:", sender);
    return null;
  }

  const text = textFromParts(messageParts(data));
  const chatId = data.chat?.id || data.chat_id || event.chat_id;
  const messageId = data.id || data.message?.id || data.message_id;
  if (!chatId || !text) return null;

  return {
    chatId,
    eventId: event.event_id || event.id || crypto.randomUUID(),
    messageId,
    sender,
    text,
  };
}

function rememberWebhookEvent(eventId) {
  if (!eventId) return true;
  if (processedWebhookEvents.has(eventId)) return false;
  processedWebhookEvents.add(eventId);
  if (processedWebhookEvents.size > 500) {
    const oldest = processedWebhookEvents.values().next().value;
    processedWebhookEvents.delete(oldest);
  }
  return true;
}

function codexPrompt(userText, inbound) {
  const prefix = env(
    "CODEX_PROMPT_PREFIX",
    "You are Codex replying to an inbound text message through Linq. Answer the user's request directly. Keep the final reply concise unless the user asks for detail. Do not mention webhook internals.",
  ).trim();

  return `${prefix}

Inbound text${inbound.sender ? ` from ${inbound.sender}` : ""}:
${userText}`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const append = (name, chunk) => {
      const value = chunk.toString("utf8");
      if (name === "stdout") stdout += value;
      else stderr += value;
      if (stdout.length + stderr.length > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(reject, new Error("Codex output exceeded the bridge buffer."));
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish(reject, new Error("Codex timed out before producing a reply."));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(`Codex exited with status ${code}.`);
      error.stderr = stderr;
      finish(reject, error);
    });

    child.stdin.end(options.input || "");
  });
}

async function runCodex(userText, inbound = {}) {
  const repoPath = path.resolve(env("CODEX_REPO_PATH", process.cwd()));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "linq-codex-"));
  const outputPath = path.join(tempDir, "reply.txt");
  const args = [
    "--ask-for-approval",
    env("CODEX_APPROVAL_POLICY", "never"),
    "exec",
    "--cd",
    repoPath,
    "--sandbox",
    env("CODEX_SANDBOX", "workspace-write"),
    "--model",
    env("CODEX_MODEL", "gpt-5.5"),
    "-c",
    `model_reasoning_effort=${env("CODEX_REASONING_EFFORT", "low")}`,
    "--output-last-message",
    outputPath,
  ];

  if (env("CODEX_SKIP_GIT_REPO_CHECK", "1") !== "0") {
    args.push("--skip-git-repo-check");
  }
  args.push("-");

  try {
    const result = await runProcess("codex", args, {
      cwd: repoPath,
      input: codexPrompt(userText, inbound),
      timeoutMs: Number(env("CODEX_TIMEOUT_MS", "120000")),
    });
    const reply = await fs.readFile(outputPath, "utf8").catch(() => result.stdout);
    const trimmed = reply.trim();
    if (!trimmed) throw new Error("Codex finished without a final reply.");
    return trimmed;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function respondToInboundMessage(inbound) {
  if (!rememberWebhookEvent(inbound.eventId)) {
    console.log("Skipping duplicate webhook event:", inbound.eventId);
    return;
  }

  console.log("Running Codex for inbound message:", {
    chat_id: inbound.chatId,
    event_id: inbound.eventId,
    sender: inbound.sender,
  });

  const dryRun = env("LINQ_DRY_RUN_REPLIES") === "1";
  if (!dryRun) await setTyping(inbound.chatId, true);
  try {
    const reply = await runCodex(inbound.text, inbound);
    if (dryRun) {
      console.log("Dry-run Codex reply:", reply);
      return;
    }
    const sent = await sendChatMessage(inbound.chatId, reply, {
      eventId: inbound.eventId,
      replyToMessageId: inbound.messageId,
    });
    console.log("Sent Codex reply:", {
      chat_id: inbound.chatId,
      event_id: inbound.eventId,
      message_id: sent.id || sent.message?.id,
    });
  } catch (error) {
    console.error("Codex bridge failed:", error.message);
    if (error.stderr) console.error(error.stderr);
    if (dryRun) {
      console.log("Dry-run Codex error reply skipped.");
      return;
    }
    if (env("CODEX_SEND_ERROR_REPLIES", "1") === "1") {
      await sendChatMessage(inbound.chatId, `Codex hit an error: ${error.message}`, {
        eventId: `${inbound.eventId}-error`,
        replyToMessageId: inbound.messageId,
      });
    }
  } finally {
    if (!dryRun) await setTyping(inbound.chatId, false);
  }
}

function handleWebhook(rawBody, headers) {
  const secret = env("LINQ_WEBHOOK_SECRET");
  if (secret && !verifyWebhookSignature(secret, rawBody, headers)) {
    return { ok: false, status: 401, error: "Invalid webhook signature." };
  }

  const event = parseJsonBody(rawBody);
  const inbound = inboundMessageFromWebhook(event);
  setImmediate(() => {
    console.log("Received Linq webhook:", summarizeWebhook(event));
    if (inbound) {
      respondToInboundMessage(inbound).catch((error) => {
        console.error("Unhandled Codex bridge error:", error);
      });
    }
  });
  return { ok: true, event, inbound: Boolean(inbound) };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        name: "linq-codex-quickstart",
        endpoints: {
          health: "GET /health",
          phone_numbers: "GET /phone-numbers",
          first_message: "POST /send-first-message",
          webhook_subscription: "POST /webhook-subscriptions",
          webhook: "POST /webhook",
          codex_smoke: "POST /codex-smoke",
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/phone-numbers") {
      sendJson(res, 200, await listPhoneNumbers());
      return;
    }

    if (req.method === "POST" && url.pathname === "/send-first-message") {
      const body = parseJsonBody(await readRawBody(req));
      const chat = await sendFirstMessage(body);
      sendJson(res, 200, {
        chat_id: chat.id,
        message_id: chat.last_message?.id,
        status: chat.last_message?.status,
        linq: chat,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook-subscriptions") {
      const body = parseJsonBody(await readRawBody(req));
      sendJson(res, 200, await createWebhookSubscription(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const result = handleWebhook(await readRawBody(req), req.headers);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/codex-smoke") {
      const body = parseJsonBody(await readRawBody(req));
      sendJson(res, 200, {
        reply: await runCodex(body.text || "Reply with: Codex bridge is ready.", {
          sender: "local-smoke-test",
        }),
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message,
      details: error.details,
    });
  }
}

async function runCli() {
  if (process.argv.includes("--phone-numbers")) {
    console.log(JSON.stringify(await listPhoneNumbers(), null, 2));
    return;
  }

  if (process.argv.includes("--send")) {
    const chat = await sendFirstMessage();
    console.log(
      JSON.stringify(
        {
          chat_id: chat.id,
          message_id: chat.last_message?.id,
          status: chat.last_message?.status,
          linq: chat,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (process.argv.includes("--subscribe-webhook")) {
    const subscription = await createWebhookSubscription();
    console.log(JSON.stringify(subscription, null, 2));
    console.error(
      "Save the returned signing_secret as LINQ_WEBHOOK_SECRET in .env.local.",
    );
    return;
  }

  if (process.argv.includes("--codex-smoke")) {
    console.log(
      await runCodex("Reply with exactly: Codex bridge is ready.", {
        sender: "local-smoke-test",
      }),
    );
    return;
  }

  const port = Number(env("PORT", "3000"));
  http.createServer(handleRequest).listen(port, "127.0.0.1", () => {
    console.log(`Linq Codex bridge listening on http://127.0.0.1:${port}`);
  });
}

runCli().catch((error) => {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
});
