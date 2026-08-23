import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listCampaigns,
  getCampaignAnalytics,
  listCampaignsSchema,
  getCampaignAnalyticsSchema,
} from "./tools/campaigns";
import {
  listSessions,
  getSessionSummary,
  listSessionsSchema,
  getSessionSummarySchema,
} from "./tools/sessions";
import { listPositions, listPositionsSchema } from "./tools/positions";
import {
  searchCandidatesBySkill,
  searchCandidatesBySkillSchema,
} from "./tools/candidates";

/**
 * Create and configure an MCP server with all analytics tools registered.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "adaptive-interview-engine",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // --- Campaigns ---
  server.registerTool(
    "listCampaigns",
    {
      description: "List all recruiting campaigns with position and session counts. Optionally filter by status.",
      inputSchema: listCampaignsSchema,
    },
    async (args) => {
      const result = await listCampaigns(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "getCampaignAnalytics",
    {
      description: "Get aggregated analytics for a campaign: average scores, completed session count, top skills, and weak areas.",
      inputSchema: getCampaignAnalyticsSchema,
    },
    async (args) => {
      const result = await getCampaignAnalytics(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // --- Sessions ---
  server.registerTool(
    "listSessions",
    {
      description: "List interview sessions with anonymized candidate info. Optionally filter by status or limit results.",
      inputSchema: listSessionsSchema,
    },
    async (args) => {
      const result = await listSessions(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "getSessionSummary",
    {
      description: "Get a summary of a single session including metadata, message count, and evaluation scores (no transcript).",
      inputSchema: getSessionSummarySchema,
    },
    async (args) => {
      const result = await getSessionSummary(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // --- Positions ---
  server.registerTool(
    "listPositions",
    {
      description: "List all positions with requirements and session counts. Optionally filter by level.",
      inputSchema: listPositionsSchema,
    },
    async (args) => {
      const result = await listPositions(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // --- Candidates ---
  server.registerTool(
    "searchCandidatesBySkill",
    {
      description: "Search candidates by skill (anonymized). Returns matching skills and experience years.",
      inputSchema: searchCandidatesBySkillSchema,
    },
    async (args) => {
      const result = await searchCandidatesBySkill(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
