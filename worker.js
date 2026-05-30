import { env, setEnv } from "./envs.js";
import { getSearchHtml } from "./utils/getHTML.js";
import searchGoogle from "./utils/searchGoogle.js";
import searchBrave from "./utils/searchBrave.js";
import searchDuckDuckGo from "./utils/searchDuckDuckGo.js";
import searchBing from "./utils/searchBing.js";

const SEARCH_ENGINES = {
  google: searchGoogle,
  brave: searchBrave,
  duckduckgo: searchDuckDuckGo,
  bing: searchBing,
};

/**
 * Parse engines parameter
 * @param {string|undefined} enginesParam - Comma-separated engine names
 * @returns {string[]} Array of valid engine names
 */
function parseEngines(enginesParam) {
  if (!enginesParam) return env.DEFAULT_ENGINES || env.SUPPORTED_ENGINES;

  return enginesParam
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => {
      // Filter out google if not enabled
      if (e === "google" && !(env.GOOGLE_API_KEY && env.GOOGLE_CX))
        return false;
      return env.SUPPORTED_ENGINES.includes(e);
    });
}

/**
 * Search with a single engine
 * @param {string} engineName - Engine name
 * @param {string} query - Search query
 * @returns {Promise<Array>} Search results
 */
async function searchSingle(engineName, query) {
  const searchFn = SEARCH_ENGINES[engineName];
  if (!searchFn) {
    console.warn(`Unknown engine: ${engineName}`);
    return [];
  }

  // 创建 AbortController 用于取消请求
  const controller = new AbortController();
  const timeout = parseInt(env.DEFAULT_TIMEOUT ?? "3000", 10);

  try {
    // 设置超时自动取消
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const result = await searchFn({ query, signal: controller.signal });

    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`[${engineName}] Timeout after ${timeout}ms`);
    } else {
      console.error(`[${engineName}] Error:`, error.message);
    }
    return [];
  }
}

/**
 * Search with all specified engines in parallel
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {string[]} [params.engines] - Array of engine names
 * @returns {Promise<Object>} Search response matching searchAll type
 */
async function searchAll({ query, engines }) {
  const enabledEngines = parseEngines(engines?.join(","));

  console.log(`[searchAll] query="${query}", engines=[${enabledEngines}]`);

  // Execute all searches in parallel
  const resultsArr = await Promise.allSettled(
    enabledEngines.map((engine) => searchSingle(engine, query))
  );

  // Collect resultsArr and track unresponsive engines
  const results = [];
  const unresponsive = [];

  resultsArr.forEach((result, index) => {
    const engineName = enabledEngines[index];
    if (result.status === "fulfilled" && result.value.length > 0) {
      results.push(
        ...result.value.map((item) => ({
          ...item,
          engine: engineName,
        }))
      );
    } else {
      unresponsive.push(engineName);
      if (result.status === "rejected") {
        console.error(`[${engineName}] Rejected:`, result.reason);
      }
    }
  });

  return {
    query,
    number_of_results: results.length,
    enabled_engines: enabledEngines,
    unresponsive_engines: unresponsive,
    results,
  };
}

/**
 * CORS headers
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

/**
 * Verify authentication token
 */
function verifyToken(request, paramToken) {
  // If TOKEN is not configured, skip authentication
  if (!env.TOKEN) {
    return true;
  }

  const token =
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    paramToken;

  return token === env.TOKEN;
}

/**
 * MCP tool definitions
 */
const MCP_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web for current information, news, or any topic. " +
      "Uses multiple engines (Brave, DuckDuckGo, Google, Bing) simultaneously " +
      "and returns aggregated results with source URLs. " +
      "Use this when you need real-time information not in your training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string" },
        engines: {
          type: "array",
          items: {
            type: "string",
            enum: ["google", "brave", "duckduckgo", "bing"],
          },
          description: "Optional: Search engines to use",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search",
    description:
      "Search across multiple search engines (Google, Brave, DuckDuckGo, Bing) and return aggregated results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string" },
        engines: {
          type: "array",
          items: {
            type: "string",
            enum: ["google", "brave", "duckduckgo", "bing"],
          },
          description: "Optional: Search engines to use",
        },
      },
      required: ["query"],
    },
  },
];

/**
 * Format search results for MCP response
 */
function formatMCPResults(result) {
  const formatted = result.results
    .map(
      (item, i) =>
        `${i + 1}. [${item.engine.toUpperCase()}] ${item.title}\n   ${item.description}\n   ${item.url}`,
    )
    .join("\n\n");

  return [
    `Search Query: "${result.query}"`,
    `Total Results: ${result.number_of_results}`,
    `Engines Used: ${result.enabled_engines.join(", ")}`,
    result.unresponsive_engines.length > 0
      ? `Unresponsive Engines: ${result.unresponsive_engines.join(", ")}`
      : null,
    "",
    "Results:",
    formatted,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Execute an MCP tool by calling the Worker's own /search endpoint.
 * This keeps the MCP layer lightweight and reuses the existing search pipeline.
 */
async function executeMCPTool(name, args) {
  if (!args || !args.query || typeof args.query !== "string") {
    return {
      content: [{ type: "text", text: "Error: query must be a non-empty string" }],
      isError: true,
    };
  }

  try {
    const result = await searchAll({ query: args.query, engines: args.engines });
    return {
      content: [{ type: "text", text: formatMCPResults(result) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Search failed: ${error.message}` }],
      isError: true,
    };
  }
}

/**
 * Send an SSE response
 */
function sseResponse(data) {
  const body = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "mcp-protocol-version": "2025-03-26",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Send a JSON error response (used when request can't be processed)
 */
function mcpErrorResponse(status, code, message) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "mcp-protocol-version": "2025-03-26",
        ...CORS_HEADERS,
      },
    },
  );
}

/**
 * Handle a single MCP JSON-RPC message
 */
async function handleMCPMessage(message) {
  const { method, id } = message;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "cloudflare-search", version: "1.2.0" },
          instructions:
            "Use web_search or search to query across multiple engines (google, brave, duckduckgo, bing).",
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: MCP_TOOLS },
      };

    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: await executeMCPTool(
          message.params?.name,
          message.params?.arguments,
        ),
      };

    case "notifications/initialized":
      return null; // No response for notifications

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

/**
 * Handle MCP Streamable HTTP requests
 */
async function handleMCP(request) {
  // GET: SSE stream (server-to-client notifications, stateless no-op)
  if (request.method === "GET") {
    return new Response(null, {
      status: 200,
      headers: {
        "mcp-protocol-version": "2025-03-26",
        ...CORS_HEADERS,
      },
    });
  }

  // DELETE: Session termination (no-op in stateless mode)
  if (request.method === "DELETE") {
    return new Response("OK", { status: 200, headers: CORS_HEADERS });
  }

  // POST: JSON-RPC messages
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return mcpErrorResponse(400, -32700, "Parse error: invalid JSON");
    }

    if (!body || typeof body.method !== "string") {
      return mcpErrorResponse(400, -32600, "Invalid Request: missing method");
    }

    try {
      const result = await handleMCPMessage(body);

      if (result === null) {
        // Notification - return 202 with no body
        return new Response(null, {
          status: 202,
          headers: {
            "mcp-protocol-version": "2025-03-26",
            ...CORS_HEADERS,
          },
        });
      }

      return sseResponse(result);
    } catch (error) {
      console.error("[MCP] Error:", error);
      return mcpErrorResponse(500, -32603, "Internal error");
    }
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: CORS_HEADERS,
  });
}

/**
 * Main request handler
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Only allow GET, POST, and DELETE
  if (
    request.method !== "GET" &&
    request.method !== "POST" &&
    request.method !== "DELETE"
  ) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  // /mcp path: handle MCP Streamable HTTP (before body parsing)
  if (url.pathname === "/mcp") {
    return handleMCP(request);
  }

  // Parse query parameters (for / and /search)
  let params = {};
  if (request.method === "POST") {
    const formData = await request.formData();
    params = Object.fromEntries(formData.entries());
  } else {
    params = Object.fromEntries(url.searchParams.entries());
  }

  // Verify authentication token (for / and /search only)
  if (!verifyToken(request, params.token)) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        message: "Invalid or missing authentication token",
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      }
    );
  }

  // Root path: return HTML UI
  if (url.pathname === "/") {
    return new Response(getSearchHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  // /search path: handle API requests
  if (url.pathname === "/search") {
    const query = params.q || params.query;

    if (!query) {
      return new Response(
        JSON.stringify({
          error: "Missing query parameter",
          message: "Please provide 'q' or 'query' parameter",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        }
      );
    }

    // Parse engines parameter (optional)
    const engines = params.engines?.split(",").filter(Boolean) || undefined;

    try {
      const response = await searchAll({ query, engines });

      return new Response(JSON.stringify(response, null, 2), {
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    } catch (error) {
      console.error("[handleRequest] Error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          },
        }
      );
    }
  }

  // 404 for other paths
  return new Response("Not Found", {
    status: 404,
    headers: CORS_HEADERS,
  });
}

export default {
  async fetch(request, env_param) {
    setEnv(env_param);
    return handleRequest(request);
  },
};
