import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  META_ACCESS_TOKEN: string;
  FACEBOOK_PAGE_ACCESS_TOKEN: string;
};

const INSTAGRAM_API_VERSION = "v25.0";
const FACEBOOK_API_VERSION = "v26.0";

const INSTAGRAM_GRAPH =
  `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;

const FACEBOOK_GRAPH =
  `https://graph.facebook.com/${FACEBOOK_API_VERSION}`;

const FACEBOOK_PAGE_ID = "142334438953384";


// ======================================================
// META API HELPERS
// ======================================================

async function graphGet(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string> = {}
) {
  const url = new URL(
    `${baseUrl}/${path.replace(/^\/+/, "")}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      (data as any)?.error?.message ??
      `Meta API GET failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}


async function graphPost(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>
) {
  const url =
    `${baseUrl}/${path.replace(/^\/+/, "")}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      (data as any)?.error?.message ??
      `Meta API POST failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}


async function graphPostForm(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, string>
) {
  const url =
    `${baseUrl}/${path.replace(/^\/+/, "")}`;

  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(body)) {
    form.set(key, value);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      (data as any)?.error?.message ??
      `Meta API POST failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}


async function getInstagramUserId(env: Env) {
  const profile = (await graphGet(
    INSTAGRAM_GRAPH,
    env.META_ACCESS_TOKEN,
    "me",
    {
      fields: "id"
    }
  )) as {
    id?: string;
  };

  if (!profile.id) {
    throw new Error(
      "Could not resolve the connected Instagram account ID."
    );
  }

  return profile.id;
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
    error instanceof Error
      ? error.message
      : "Unknown Meta API error";

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


// ======================================================
// MCP SERVER
// ======================================================

function createServer(env: Env) {
  const server = new McpServer({
    name: "TBG Motors Social",
    version: "1.3.0"
  });


  // ====================================================
  // INSTAGRAM — READ
  // ====================================================

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
            fields:
              "id,username,account_type"
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
        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
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
            limit:
              String(limit ?? 10)
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
        "Get one Instagram post, Reel or carousel by media ID. Read-only.",
      inputSchema: {
        media_id:
          z.string().min(1)
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
        "List comments on a TBG Motors Instagram post or Reel. Read-only.",
      inputSchema: {
        media_id:
          z.string().min(1),

        limit:
          z.number()
            .int()
            .min(1)
            .max(50)
            .optional()
      }
    },
    async ({ media_id, limit }) => {
      try {
        const data = await graphGet(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${media_id}/comments`,
          {
            fields:
              "id,text,timestamp",
            limit:
              String(limit ?? 20)
          }
        );

        return result(data);
      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // INSTAGRAM — CREATE CONTAINERS
  // These DO NOT publish publicly
  // ====================================================

  server.registerTool(
    "create_instagram_photo_container",
    {
      description:
        "Prepare an Instagram photo post for TBG Motors. This creates a media container but does NOT publish it. The image must be available at a public HTTPS URL.",
      inputSchema: {
        image_url:
          z.string().url(),

        caption:
          z.string()
            .max(2200)
            .optional(),

        alt_text:
          z.string()
            .max(1000)
            .optional(),

        is_ai_generated:
          z.boolean()
            .optional()
      }
    },
    async ({
      image_url,
      caption,
      alt_text,
      is_ai_generated
    }) => {
      try {
        const igId =
          await getInstagramUserId(env);

        const body:
          Record<string, unknown> = {
            image_url
          };

        if (caption) {
          body.caption = caption;
        }

        if (alt_text) {
          body.alt_text = alt_text;
        }

        if (
          is_ai_generated !== undefined
        ) {
          body.is_ai_generated =
            is_ai_generated;
        }

        const data = await graphPost(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${igId}/media`,
          body
        );

        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  server.registerTool(
    "create_instagram_reel_container",
    {
      description:
        "Prepare an Instagram Reel for TBG Motors. This creates/uploads the Reel container but does NOT publish it. The video must be available at a public HTTPS URL.",
      inputSchema: {
        video_url:
          z.string().url(),

        caption:
          z.string()
            .max(2200)
            .optional(),

        cover_url:
          z.string()
            .url()
            .optional(),

        share_to_feed:
          z.boolean()
            .optional(),

        audio_name:
          z.string()
            .optional(),

        is_ai_generated:
          z.boolean()
            .optional()
      }
    },

    async ({
      video_url,
      caption,
      cover_url,
      share_to_feed,
      audio_name,
      is_ai_generated
    }) => {
      try {

        const igId =
          await getInstagramUserId(env);

        const body:
          Record<string, unknown> = {
            media_type: "REELS",
            video_url
          };

        if (caption) {
          body.caption = caption;
        }

        if (cover_url) {
          body.cover_url = cover_url;
        }

        if (
          share_to_feed !== undefined
        ) {
          body.share_to_feed =
            share_to_feed;
        }

        if (audio_name) {
          body.audio_name =
            audio_name;
        }

        if (
          is_ai_generated !== undefined
        ) {
          body.is_ai_generated =
            is_ai_generated;
        }

        const data = await graphPost(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${igId}/media`,
          body
        );

        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  server.registerTool(
    "create_instagram_carousel_container",
    {
      description:
        "Prepare an Instagram carousel for TBG Motors from 2 to 10 public image/video URLs. Creates child containers and the parent carousel but does NOT publish.",
      inputSchema: {

        items:
          z.array(
            z.object({
              type:
                z.enum([
                  "IMAGE",
                  "VIDEO"
                ]),

              url:
                z.string().url(),

              alt_text:
                z.string()
                  .max(1000)
                  .optional()
            })
          )
          .min(2)
          .max(10),

        caption:
          z.string()
            .max(2200)
            .optional(),

        is_ai_generated:
          z.boolean()
            .optional()
      }
    },

    async ({
      items,
      caption,
      is_ai_generated
    }) => {

      try {

        const igId =
          await getInstagramUserId(env);

        const childIds:
          string[] = [];


        for (const item of items) {

          const childBody:
            Record<string, unknown> = {
              is_carousel_item: true
            };


          if (
            item.type === "IMAGE"
          ) {

            childBody.image_url =
              item.url;

            if (item.alt_text) {
              childBody.alt_text =
                item.alt_text;
            }

          } else {

            childBody.video_url =
              item.url;

            childBody.media_type =
              "VIDEO";
          }


          const child =
            (await graphPost(
              INSTAGRAM_GRAPH,
              env.META_ACCESS_TOKEN,
              `${igId}/media`,
              childBody
            )) as {
              id?: string;
            };


          if (!child.id) {
            throw new Error(
              "Meta did not return an Instagram carousel child ID."
            );
          }


          childIds.push(
            child.id
          );
        }


        const parentBody:
          Record<string, unknown> = {

            media_type:
              "CAROUSEL",

            children:
              childIds.join(",")
          };


        if (caption) {
          parentBody.caption =
            caption;
        }


        if (
          is_ai_generated !== undefined
        ) {
          parentBody.is_ai_generated =
            is_ai_generated;
        }


        const parent =
          await graphPost(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${igId}/media`,
            parentBody
          );


        return result({
          child_container_ids:
            childIds,

          carousel_container:
            parent
        });

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  server.registerTool(
    "check_instagram_container",
    {
      description:
        "Check whether an Instagram media container is ready to publish. Read-only. For Reels/video wait for status_code FINISHED before publishing.",
      inputSchema: {
        container_id:
          z.string().min(1)
      }
    },

    async ({
      container_id
    }) => {

      try {

        const data =
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            container_id,
            {
              fields:
                "id,status_code"
            }
          );

        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  server.registerTool(
    "publish_instagram_media",
    {
      description:
        "FINAL PUBLICATION ACTION. Publish a prepared Instagram photo, Reel or carousel container to the public TBG Motors Instagram account. Only use after the user explicitly asks to publish.",
      inputSchema: {
        creation_id:
          z.string().min(1)
      }
    },

    async ({
      creation_id
    }) => {

      try {

        const igId =
          await getInstagramUserId(env);


        const data =
          await graphPost(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${igId}/media_publish`,
            {
              creation_id
            }
          );


        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — READ
  // ====================================================

  server.registerTool(
    "get_facebook_page",
    {
      description:
        "Get the TBG Motors Facebook Page profile. Read-only.",
      inputSchema: {}
    },

    async () => {

      try {

        const data =
          await graphGet(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            FACEBOOK_PAGE_ID,
            {
              fields:
                "id,name,link,username"
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

        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      }
    },

    async ({ limit }) => {

      try {

        const data =
          await graphGet(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/posts`,
            {
              fields:
                "id,message,created_time,permalink_url",

              limit:
                String(limit ?? 10)
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

        post_id:
          z.string().min(1)
      }
    },

    async ({ post_id }) => {

      try {

        const data =
          await graphGet(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            post_id,
            {
              fields:
                "id,message,created_time,permalink_url"
            }
          );

        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — PHOTO PREPARATION
  // ====================================================

  server.registerTool(
    "create_facebook_photo_upload",
    {
      description:
        "Upload a photo to the TBG Motors Facebook Page as unpublished media. This does NOT create a public Facebook post. The image must be available at a public HTTPS URL.",

      inputSchema: {

        image_url:
          z.string().url()
      }
    },

    async ({ image_url }) => {

      try {

        const data =
          await graphPost(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/photos`,
            {
              url: image_url,
              published: false
            }
          );

        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — FINAL PHOTO POST
  // ====================================================

  server.registerTool(
    "publish_facebook_photo_post",
    {
      description:
        "FINAL PUBLICATION ACTION. Publish a Facebook Page post containing 1 to 10 previously uploaded Facebook photo IDs. Only use after the user explicitly asks to publish.",

      inputSchema: {

        photo_ids:
          z.array(
            z.string().min(1)
          )
          .min(1)
          .max(10),

        message:
          z.string()
            .optional()
      }
    },

    async ({
      photo_ids,
      message
    }) => {

      try {

        const form:
          Record<string, string> = {};


        if (message) {
          form.message =
            message;
        }


        photo_ids.forEach(
          (id, index) => {

            form[
              `attached_media[${index}]`
            ] =
              JSON.stringify({
                media_fbid: id
              });

          }
        );


        const data =
          await graphPostForm(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/feed`,
            form
          );


        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — TEXT / LINK POST
  // ====================================================

  server.registerTool(
    "publish_facebook_text_post",
    {
      description:
        "FINAL PUBLICATION ACTION. Publish a text or link post to the public TBG Motors Facebook Page. Only use after the user explicitly asks to publish.",

      inputSchema: {

        message:
          z.string().min(1),

        link:
          z.string()
            .url()
            .optional()
      }
    },

    async ({
      message,
      link
    }) => {

      try {

        const body:
          Record<string, unknown> = {

            message,
            published: true
          };


        if (link) {
          body.link =
            link;
        }


        const data =
          await graphPost(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/feed`,
            body
          );


        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — REEL PREPARATION
  // ====================================================

  server.registerTool(
    "create_facebook_reel_upload",
    {
      description:
        "Prepare and upload a Facebook Reel for TBG Motors from a public HTTPS video URL. This does NOT publish the Reel.",

      inputSchema: {

        video_url:
          z.string().url()
      }
    },

    async ({ video_url }) => {

      try {

        const start =
          (await graphPost(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/video_reels`,
            {
              upload_phase:
                "start"
            }
          )) as {

            video_id?:
              string;

            upload_url?:
              string;
          };


        if (
          !start.video_id ||
          !start.upload_url
        ) {

          throw new Error(
            "Meta did not return a Facebook Reel video_id and upload_url."
          );
        }


        const uploadResponse =
          await fetch(
            start.upload_url,
            {
              method: "POST",

              headers: {

                Authorization:
                  `OAuth ${env.FACEBOOK_PAGE_ACCESS_TOKEN}`,

                file_url:
                  video_url
              }
            }
          );


        const uploadData =
          await uploadResponse.json();


        if (
          !uploadResponse.ok
        ) {

          const message =
            (uploadData as any)
              ?.error
              ?.message
            ??
            `Facebook Reel upload failed with HTTP ${uploadResponse.status}`;


          throw new Error(
            message
          );
        }


        return result({

          video_id:
            start.video_id,

          upload_result:
            uploadData
        });

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — REEL STATUS
  // ====================================================

  server.registerTool(
    "check_facebook_reel",
    {
      description:
        "Check processing status of a prepared Facebook Reel. Read-only.",

      inputSchema: {

        video_id:
          z.string().min(1)
      }
    },

    async ({ video_id }) => {

      try {

        const data =
          await graphGet(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            video_id,
            {
              fields:
                "id,status"
            }
          );


        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  // ====================================================
  // FACEBOOK — FINAL REEL PUBLICATION
  // ====================================================

  server.registerTool(
    "publish_facebook_reel",
    {
      description:
        "FINAL PUBLICATION ACTION. Publish a previously uploaded Facebook Reel to the public TBG Motors Facebook Page. Only use after the user explicitly asks to publish.",

      inputSchema: {

        video_id:
          z.string().min(1),

        description:
          z.string()
            .optional(),

        title:
          z.string()
            .optional()
      }
    },

    async ({
      video_id,
      description,
      title
    }) => {

      try {

        const body:
          Record<string, unknown> = {

            video_id,

            upload_phase:
              "finish",

            video_state:
              "PUBLISHED"
          };


        if (description) {
          body.description =
            description;
        }


        if (title) {
          body.title =
            title;
        }


        const data =
          await graphPost(
            FACEBOOK_GRAPH,
            env.FACEBOOK_PAGE_ACCESS_TOKEN,
            `${FACEBOOK_PAGE_ID}/video_reels`,
            body
          );


        return result(data);

      } catch (error) {
        return errorResult(error);
      }
    }
  );


  return server;
}


// ======================================================
// CLOUDFLARE WORKER ENTRY
// ======================================================

export default {

  fetch(
    request,
    env,
    ctx
  ) {

    return createMcpHandler(
      () =>
        createServer(
          env as Env
        )
    )(
      request,
      env,
      ctx
    );
  }

} satisfies ExportedHandler<Env>;
