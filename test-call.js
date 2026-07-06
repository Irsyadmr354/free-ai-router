import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use process.execPath instead of the string "node" — this is the exact
// path to the Node binary currently running this script, so it works
// regardless of how PATH is set up in the parent shell (nvm, WSL, etc).
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

const toolCall = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "chat_completion",
    arguments: {
      prompt: "say hello in one sentence",
    },
  },
};

let buffer = "";

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete last line

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      console.log("RAW RESPONSE:", JSON.stringify(msg, null, 2));

      if (msg.id === 1) {
        // Init handshake done — send initialized notification then tool call
        const initialized = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
        server.stdin.write(JSON.stringify(initialized) + "\n");
        server.stdin.write(JSON.stringify(toolCall) + "\n");
      }

      if (msg.id === 2) {
        // Tool result received — print cleanly and exit
        console.log("\n=== TOOL RESULT ===");
        const content = msg.result?.content?.[0]?.text ?? "(no text content)";
        console.log(content);
        console.log("===================\n");
        server.kill();
        process.exit(0);
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
