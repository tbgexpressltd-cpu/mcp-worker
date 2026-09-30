import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  META_ACCESS_TOKEN: string;
};

const API_VERSION = "v25.0";
const GRAPH_BASE = `https://graph.instagram.com/${API_VERSION}`;

async function metaGet(
  env: Env,
  path: string,
  params: Record<string, string> = {}
) {
  const url = new URL(`${GRAPH_BASE}/${path.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      (data as any)?.error?.message ??
      `Meta API request failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function result(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown Meta API error";

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message
      }
    ]
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "TBG Motors Social",
    version: "1.0.0"
  });

  server.registerTool(
    "get_instagram_profile",
    {
      description:
        "Get the connected TBG Motors Instagram Business profile. Read-only.",
      inputSchema: {}
    },
    async () => {
      try {
        const data = await metaGet(env, "me", {
          fields: "id,username,account_type"
        });

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_instagram_media",
    {
      description:
        "List recent posts, Reels and carousel albums from the connected TBG Motors Instagram Business account. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ limit }) => {
      try {
        const data = await metaGet(env, "me/media", {
          fields:
            "id,caption,media_type,media_product_type,permalink,timestamp",
          limit: String(limit ?? 10)
        });

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_instagram_media",
    {
      description:
        "Get details for one Instagram post, Reel or carousel by its Instagram media ID. Read-only.",
      inputSchema: {
        media_id: z.string().min(1)
      }
    },
    async ({ media_id }) => {
      try {
        const data = await metaGet(env, media_id, {
          fields:
            "id,caption,media_type,media_product_type,permalink,timestamp"
        });

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createServer(env))(
      request,
      env,
      ctx
    );
  }
} satisfies ExportedHandler<Env>;
