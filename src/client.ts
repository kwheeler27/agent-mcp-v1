import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Helpers ──
const log = (...args: unknown[]) => console.log("[client]", ...args);
const divider = () => console.log("─".repeat(60));

// ── Setup paths ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "server.js");

// ── Anthropic client ──
const anthropic = new Anthropic();

// ── MCP types → Anthropic tool format ──
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ── Main ──
async function main() {
  // 1. Spawn the MCP server and connect
  log("Spawning MCP server…");
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });

  const mcpClient = new Client({ name: "edu-mcp-client", version: "1.0.0" });
  await mcpClient.connect(transport);
  log("Connected to MCP server.");
  divider();

  // 2. Discover tools
  log("Discovering tools…");
  const { tools: mcpTools } = await mcpClient.listTools();

  const anthropicTools: AnthropicTool[] = mcpTools.map((t) => {
    log(`  Tool: ${t.name} — ${t.description}`);
    return {
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as AnthropicTool["input_schema"],
    };
  });
  log(`${anthropicTools.length} tools available.`);
  divider();

  // 3. Build system prompt from discovered tools
  const toolList = anthropicTools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const systemPrompt = `You are a helpful assistant with access to these tools:\n${toolList}\n\nAlways prefer using the specific tool designed for a task rather than a general-purpose tool like fetch_url. For example, use get_sports_scores for sports scores, get_weather for weather, and the file tools for file operations.`;

  // 4. Agent loop
  async function processQuery(userQuery: string): Promise<string> {
    log(`>>> Sending query to Claude: "${userQuery}"`);

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userQuery },
    ];

    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

      log(`<<< Claude stop_reason: ${response.stop_reason}`);

      // Collect any text blocks for the final answer
      const textBlocks = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);

      // If Claude is done talking, return the text
      if (response.stop_reason === "end_turn") {
        return textBlocks.join("\n") || "(no text response)";
      }

      // If Claude wants to use tools, handle each tool call
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        // Push assistant message with all content (text + tool_use)
        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          log(`>>> Calling MCP tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

          const result = await mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input as Record<string, unknown>,
          });

          const contentArr = result.content as Array<{ type: string; text?: string }>;
          const text = contentArr
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");

          log(`<<< MCP result (${text.length} chars): ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: text,
            is_error: result.isError === true,
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Any other stop reason – return what we have
      return textBlocks.join("\n") || "(unexpected stop)";
    }

    return "(reached max iterations)";
  }

  // 4. Interactive REPL
  console.log("\n🤖 MCP Agent ready! Try these example queries:");
  console.log('  • "Read the contents of example.txt"');
  console.log('  • "What files are in my workspace?"');
  console.log('  • "What\'s the weather in London?"');
  console.log('  • "What are today\'s NBA scores?"');
  console.log('  • "Create a file called notes.txt with hello world, then read it back"');
  console.log('  • "What is 2 + 2?"  (no tools needed)');
  console.log('  Type "quit" or "exit" to stop.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return prompt();
      if (trimmed === "quit" || trimmed === "exit") {
        log("Shutting down…");
        await mcpClient.close();
        rl.close();
        process.exit(0);
      }

      divider();
      try {
        const answer = await processQuery(trimmed);
        divider();
        console.log(`\nAssistant: ${answer}\n`);
      } catch (err) {
        console.error("Error:", err);
      }
      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
