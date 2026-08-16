#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { createLlmProviderFromEnv } from "../llm/providerFactory.js";
import {
  AnswerExampleLibrary,
  CoverLetterLibrary,
  ResumeLibrary,
  SearchBroker,
  extractContentTool,
} from "../tools/index.js";
import type { Tool } from "../types/tool.js";

/**
 * Matches README's "MCP Compatibility" section (Resume Library, Search,
 * vacancy scraper listed as candidate MCP servers). Every Tool in this
 * codebase was already shaped like an MCP tool (name/description/zod-schema/
 * execute) from increment 1 — this is the thin adapter that was promised, not
 * a rewrite: it maps each Tool straight onto McpServer.registerTool().
 *
 * This is a separate process/entry point from the CLI (`npm run mcp`, not
 * `npm run cli`) — any MCP-compatible client (Claude Desktop, Claude Code,
 * etc.) can connect to it directly and use these capabilities standalone,
 * independent of this project's own orchestrator.
 */
const llmProvider = createLlmProviderFromEnv();

const tools: Tool<unknown, unknown>[] = [
  new SearchBroker() as Tool<unknown, unknown>,
  new ResumeLibrary(llmProvider) as Tool<unknown, unknown>,
  new CoverLetterLibrary() as Tool<unknown, unknown>,
  new AnswerExampleLibrary() as Tool<unknown, unknown>,
  extractContentTool as Tool<unknown, unknown>,
];

const server = new McpServer({ name: "rolecase", version: "0.1.0" });

function registerTool(tool: Tool<unknown, unknown>): void {
  // MCP tool names are unconstrained at the protocol level, but some client
  // integrations restrict them to function-call-safe identifiers — dots (our
  // internal "namespace.action" convention) are replaced defensively.
  const mcpName = tool.name.replace(/\./g, "_");
  const inputShape = (tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  const outputShape = (tool.outputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape;

  server.registerTool(
    mcpName,
    {
      description: tool.description,
      inputSchema: inputShape,
      outputSchema: outputShape,
    },
    async (args: unknown) => {
      const output = await tool.execute(args, {});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output as Record<string, unknown>,
      };
    }
  );
}

tools.forEach(registerTool);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});
