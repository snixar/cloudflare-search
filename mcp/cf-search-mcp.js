#!/usr/bin/env node

/**
 * Cloudflare Search MCP Server
 *
 * This MCP server provides access to the Cloudflare Search API,
 * allowing AI assistants to search across multiple search engines.
 *
 * Supports two transports:
 * - Stdio (default): Standard input/output, used by Claude Code, OpenClaw, etc.
 * - Streamable HTTP: HTTP-based transport with SSE streaming support
 *
 * Environment Variables:
 * - CF_SEARCH_URL: The URL of your Cloudflare Search Worker (required)
 * - CF_SEARCH_TOKEN: Authentication token for the search API (optional)
 * - CF_SEARCH_HTTP_PORT: Enable Streamable HTTP server on this port (optional)
 * - CF_SEARCH_HTTP_HOST: Host to bind HTTP server (default: 127.0.0.1)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

// Get configuration from environment variables
const CF_SEARCH_URL = process.env.CF_SEARCH_URL;
const CF_SEARCH_TOKEN = process.env.CF_SEARCH_TOKEN;
const CF_SEARCH_HTTP_PORT = process.env.CF_SEARCH_HTTP_PORT
  ? parseInt(process.env.CF_SEARCH_HTTP_PORT, 10)
  : null;
const CF_SEARCH_HTTP_HOST = process.env.CF_SEARCH_HTTP_HOST || "127.0.0.1";

if (!CF_SEARCH_URL) {
  console.error("Error: CF_SEARCH_URL environment variable is required");
  console.error(
    "Example: export CF_SEARCH_URL=https://your-worker.workers.dev",
  );
  process.exit(1);
}

/**
 * Call the Cloudflare Search API
 */
async function searchAPI(query, engines = null) {
  try {
    const params = new URLSearchParams({ q: query });

    if (engines && engines.length > 0) {
      params.append("engines", engines.join(","));
    }

    if (CF_SEARCH_TOKEN) {
      params.append("token", CF_SEARCH_TOKEN);
    }

    const url = `${CF_SEARCH_URL}/search?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(`Failed to search: ${error.message}`);
  }
}

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query string",
    },
    engines: {
      type: "array",
      items: {
        type: "string",
        enum: ["google", "brave", "duckduckgo", "bing"],
      },
      description:
        "Optional: Array of search engines to use. If not specified, uses default engines. " +
        "Available engines: google, brave, duckduckgo, bing",
    },
  },
  required: ["query"],
};

/**
 * Format search results into readable text
 */
function formatSearchResults(result) {
  const formattedResults = result.results
    .map((item, index) => {
      return `${index + 1}. [${item.engine.toUpperCase()}] ${item.title}\n   ${item.description}\n   ${item.url}`;
    })
    .join("\n\n");

  const summary = [
    `Search Query: "${result.query}"`,
    `Total Results: ${result.number_of_results}`,
    `Engines Used: ${result.enabled_engines.join(", ")}`,
    result.unresponsive_engines.length > 0
      ? `Unresponsive Engines: ${result.unresponsive_engines.join(", ")}`
      : null,
    "",
    "Results:",
    formattedResults,
  ]
    .filter(Boolean)
    .join("\n");

  return summary;
}

/**
 * Handle tool execution
 */
async function handleToolCall(toolName, args) {
  if (toolName !== "search" && toolName !== "web_search") {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  if (!args) {
    throw new Error("Missing arguments");
  }

  const { query, engines } = args;

  if (!query || typeof query !== "string") {
    throw new Error("Query must be a non-empty string");
  }

  const result = await searchAPI(query, engines);

  return {
    content: [
      {
        type: "text",
        text: formatSearchResults(result),
      },
    ],
  };
}

/**
 * Create and configure a new MCP Server instance.
 * Each transport needs its own server instance.
 */
function createServer() {
  const server = new Server(
    {
      name: "cloudflare-search",
      version: "1.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "web_search",
          description:
            "Search the web for current information, news, or any topic. " +
            "Uses multiple engines (Brave, DuckDuckGo, Google, Bing) simultaneously " +
            "and returns aggregated results with source URLs. " +
            "Use this when you need real-time information not in your training data. ",
          inputSchema: SEARCH_INPUT_SCHEMA,
        },
        {
          name: "search",
          description:
            "Search across multiple search engines (Google, Brave, DuckDuckGo, Bing) and return aggregated results. " +
            "This tool provides comprehensive search results from multiple sources, with source attribution for each result.",
          inputSchema: SEARCH_INPUT_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(
        request.params.name,
        request.params.arguments,
      );
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Search failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the server
 */
async function main() {
  // Always start stdio transport
  const stdioServer = createServer();
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);

  console.error("Cloudflare Search MCP Server running on stdio");
  console.error(`Connected to: ${CF_SEARCH_URL}`);

  // Start Streamable HTTP server if port is configured
  if (CF_SEARCH_HTTP_PORT) {
    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Max-Age", "86400");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check endpoint
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            name: "cloudflare-search",
            version: "1.2.0",
            transports: ["stdio", "streamable-http"],
          }),
        );
        return;
      }

      // MCP Streamable HTTP endpoint
      if (req.url === "/mcp" || req.url?.startsWith("/mcp")) {
        try {
          // Stateless mode: create a new transport + server per request
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          const server = createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("Error handling MCP HTTP request:", error);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message: "Internal server error",
                },
                id: null,
              }),
            );
          }
        }
        return;
      }

      // 404 for other paths
      res.writeHead(404);
      res.end("Not Found");
    });

    httpServer.listen(CF_SEARCH_HTTP_PORT, CF_SEARCH_HTTP_HOST, () => {
      console.error(
        `Streamable HTTP server listening on http://${CF_SEARCH_HTTP_HOST}:${CF_SEARCH_HTTP_PORT}`,
      );
      console.error(
        `MCP endpoint: http://${CF_SEARCH_HTTP_HOST}:${CF_SEARCH_HTTP_PORT}/mcp`,
      );
    });
  } else {
    console.error(
      "Streamable HTTP server not started (set CF_SEARCH_HTTP_PORT to enable)",
    );
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
