import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  META_ACCESS_TOKEN: string;
  FACEBOOK_PAGE_ACCESS_TOKEN: string;
};

const INSTAGRAM_API_VERSION = "v25.0";
const FACEBOOK_API_VERSION = "v26.0";

const INSTAGRAM_GRAPH = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;
const FACEBOOK_GRAPH = `https://graph.facebook.com/${FACEBOOK_API_VERSION}`;

const FACEBOOK_PAGE_ID = "142334438953384";

async function graphGet(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string> = {}
) {
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`
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
    version: "1.1.0"
  });

  // INSTAGRAM

  server.registerTool(
    "get_instagram_profile",
    {
      description:
        "Get the connected TBG Motors Instagram Business profile. Read-only.",
      inputSchema: {}
    },
    async () => {
      try {
        const data = await graphGet(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          "me",
          {
            fields: "id,username,account_type"
          }
        );

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
        "List recent TBG Motors Instagram posts, Reels and carousel albums. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ limit }) => {
      try {
        const data = await graphGet(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          "me/media",
          {
            fields:
              "id,caption,media_type,media_product_type,permalink,timestamp",
            limit: String(limit ?? 10)
          }
        );

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
        "Get details for one Instagram post, Reel or carousel by media ID. Read-only.",
      inputSchema: {
        media_id: z.string().min(1)
      }
    },
    async ({ media_id }) => {
      try {
        const data = await graphGet(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          media_id,
          {
            fields:
              "id,caption,media_type,media_product_type,permalink,timestamp"
          }
        );

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_instagram_comments",
    {
      description:
        "List comments for a TBG Motors Instagram post or Reel by media ID. Read-only.",
      inputSchema: {
        media_id: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ media_id, limit }) => {
      try {
        const data = await graphGet(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${media_id}/comments`,
          {
            fields: "id,text,timestamp",
            limit: String(limit ?? 20)
          }
        );

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // FACEBOOK

  server.registerTool(
    "get_facebook_page",
    {
      description:
        "Get the TBG Motors Facebook Page profile and linked Instagram Business account. Read-only.",
      inputSchema: {}
    },
    async () => {
      try {
        const data = await graphGet(
          FACEBOOK_GRAPH,
          env.FACEBOOK_PAGE_ACCESS_TOKEN,
          FACEBOOK_PAGE_ID,
          {
            fields:
              "id,name,link,username,instagram_business_account{id,username}"
          }
        );

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "list_facebook_posts",
    {
      description:
        "List recent posts published by the TBG Motors Facebook Page. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional()
      }
    },
    async ({ limit }) => {
      try {
        const data = await graphGet(
          FACEBOOK_GRAPH,
          env.FACEBOOK_PAGE_ACCESS_TOKEN,
          `${FACEBOOK_PAGE_ID}/posts`,
          {
            fields: "id,message,created_time,permalink_url",
            limit: String(limit ?? 10)
          }
        );

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_facebook_post",
    {
      description:
        "Get one TBG Motors Facebook Page post by post ID. Read-only.",
      inputSchema: {
        post_id: z.string().min(1)
      }
    },
    async ({ post_id }) => {
      try {
        const data = await graphGet(
          FACEBOOK_GRAPH,
          env.FACEBOOK_PAGE_ACCESS_TOKEN,
          post_id,
          {
            fields: "id,message,created_time,permalink_url"
          }
        );

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
