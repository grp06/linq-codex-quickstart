#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templateDir = path.join(skillDir, "assets", "bridge-template");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function normalizeUsPhone(value, label) {
  const raw = String(value || "").trim();
  if (/^\+1\d{10}$/.test(raw)) {
    return raw;
  }

  const digits = raw.replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) {
    return `+1${digits}`;
  }
  if (/^1\d{10}$/.test(digits)) {
    return `+${digits}`;
  }

  throw new Error(`${label} must be a US phone number that can normalize to +1XXXXXXXXXX.`);
}

function envLine(key, value) {
  return `${key}=${String(value ?? "").replace(/\n/g, "\\n")}`;
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function main() {
  const configPath = argValue("--config");
  if (!configPath) {
    throw new Error("Usage: scaffold-bridge.mjs --config /path/config.json");
  }

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const targetDir = path.resolve(config.targetDir || "linq-codex-quickstart");
  const linqFromNumber = normalizeUsPhone(
    config.linqFromNumber,
    "linqFromNumber",
  );
  const linqToNumber = normalizeUsPhone(config.linqToNumber, "linqToNumber");
  if (!config.linqApiKey) {
    throw new Error("linqApiKey is required.");
  }

  await fs.mkdir(targetDir, { recursive: true });
  await copyDir(templateDir, targetDir);

  const codexRepoPath = path.resolve(config.codexRepoPath || targetDir);
  const envLocal = [
    envLine("LINQ_API_KEY", config.linqApiKey),
    envLine("LINQ_FROM_NUMBER", linqFromNumber),
    envLine("LINQ_TO_NUMBER", linqToNumber),
    envLine("LINQ_FIRST_MESSAGE", config.firstMessage || "Hello from Linq!"),
    envLine("LINQ_ALLOWED_SENDER", linqToNumber),
    "",
    envLine("PORT", config.port || "3000"),
    envLine("PUBLIC_WEBHOOK_URL", config.publicWebhookUrl || ""),
    envLine("LINQ_WEBHOOK_SECRET", config.linqWebhookSecret || ""),
    "",
    envLine("CODEX_REPO_PATH", codexRepoPath),
    envLine("CODEX_MODEL", config.codexModel || "gpt-5.5"),
    envLine("CODEX_REASONING_EFFORT", config.codexReasoningEffort || "low"),
    envLine("CODEX_SANDBOX", config.codexSandbox || "workspace-write"),
    envLine("CODEX_APPROVAL_POLICY", config.codexApprovalPolicy || "never"),
    envLine("CODEX_TIMEOUT_MS", config.codexTimeoutMs || "120000"),
    envLine("CODEX_SEND_ERROR_REPLIES", "1"),
    envLine(
      "CODEX_PROMPT_PREFIX",
      config.codexPromptPrefix ||
        "You are Codex replying to an inbound text message through Linq. Answer directly and keep it concise unless the user asks for detail.",
    ),
    "",
  ].join("\n");

  await fs.writeFile(path.join(targetDir, ".env.local"), envLocal, {
    mode: 0o600,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetDir,
        envLocal: path.join(targetDir, ".env.local"),
        fromNumber: linqFromNumber,
        toNumber: linqToNumber,
        apiKey: "[redacted]",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
