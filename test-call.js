import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = spawn(process.execPath, ["index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: __dirname,
});

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

// ---------------------------------------------------------------------------
// Test 1 — baseline: short prompt, Tier 0/1 run but save nothing (no excess)
// ---------------------------------------------------------------------------
const test1 = {
  jsonrpc: "2.0", id: 2,
  method: "tools/call",
  params: {
    name: "chat_completion",
    arguments: { prompt: "say hello in one sentence", show_token_savings: true },
  },
};

// ---------------------------------------------------------------------------
// Test 2 — Tier 1 context trimming: long message history that should trigger
// context window trimming and report metadata correctly
// ---------------------------------------------------------------------------
const longHistory = Array.from({ length: 15 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `Message ${i + 1}: ${"This is a test message that takes up some tokens. ".repeat(20)}`,
}));
longHistory.push({ role: "user", content: "Summarize what we discussed." });

const test2 = {
  jsonrpc: "2.0", id: 3,
  method: "tools/call",
  params: {
    name: "chat_completion",
    arguments: { messages: longHistory, show_token_savings: true, max_tokens: 100 },
  },
};

// ---------------------------------------------------------------------------
// Test 3 — Tier 2 abbreviation dictionary: ROI check — legend is big, should
// skip if savings < overhead and report applied: false
// ---------------------------------------------------------------------------
const test3 = {
  jsonrpc: "2.0", id: 4,
  method: "tools/call",
  params: {
    name: "chat_completion",
    arguments: {
      prompt: "hi",  // very short — abbreviation overhead will exceed savings
      abbreviation_dictionary: { "hello": "hi", "world": "wrld", "function": "fn" },
      show_token_savings: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Test 4 — get_token_savings_report tool
// ---------------------------------------------------------------------------
const test4 = {
  jsonrpc: "2.0", id: 5,
  method: "tools/call",
  params: { name: "get_token_savings_report", arguments: {} },
};

const tests = [test1, test2, test3, test4];
let testIdx = 0;
let buffer = "";
let initialized = false;

function sendNext() {
  if (testIdx >= tests.length) {
    console.log("\n✅ All tests complete.");
    server.kill();
    process.exit(0);
  }
  server.stdin.write(JSON.stringify(tests[testIdx]) + "\n");
}

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);

      if (msg.id === 1) {
        const initNotif = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
        server.stdin.write(JSON.stringify(initNotif) + "\n");
        initialized = true;
        sendNext();
      }

      // Match any test response (id 2-5)
      if (msg.id >= 2 && initialized) {
        const testNum = msg.id - 1;
        const content = msg.result?.content?.[0]?.text ?? msg.error?.message ?? "(no content)";
        console.log(`\n=== TEST ${testNum} RESULT (id=${msg.id}) ===`);
        console.log(content);
        console.log("=".repeat(40));
        testIdx++;
        sendNext();
      }
    } catch {
      // not JSON
    }
  }
});

server.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`Server exited with code ${code}`);
    process.exit(1);
  }
});

server.stdin.write(JSON.stringify(init) + "\n");
