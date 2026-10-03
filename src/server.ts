import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  // Existing Instagram API with Instagram Login token.
  META_ACCESS_TOKEN: string;

  // IMPORTANT:
  // Despite the historical variable name, this now stores
  // the permanent Meta SYSTEM USER access token.
  FACEBOOK_PAGE_ACCESS_TOKEN: string;

  // NEW:
  // Facebook USER access token for Instagram API
  // with Facebook Login.
  //
  // Required for Instagram Audio API.
  //
  // This is optional so the Worker can deploy before
  // we configure the token in Cloudflare.
  INSTAGRAM_FB_USER_ACCESS_TOKEN?: string;

  SOCIAL_MEDIA: R2Bucket;
};

const INSTAGRAM_API_VERSION = "v25.0";
const FACEBOOK_API_VERSION = "v26.0";

const INSTAGRAM_GRAPH =
  `https://graph.instagram.com/${INSTAGRAM_API_VERSION}`;

const FACEBOOK_GRAPH =
  `https://graph.facebook.com/${FACEBOOK_API_VERSION}`;

const FACEBOOK_PAGE_ID =
  "142334438953384";

const PUBLIC_WORKER_BASE =
  "https://mcp-worker.tbgexpressltd.workers.dev";


// ======================================================
// CHATGPT FILE INPUT
// ======================================================

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
}).strict();

type OpenAIFile =
  z.infer<typeof OpenAIFileSchema>;


function extensionFromMime(
  mime?: string
) {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";

    case "image/png":
      return ".png";

    case "image/webp":
      return ".webp";

    case "video/mp4":
      return ".mp4";

    case "video/quicktime":
      return ".mov";

    default:
      return "";
  }
}


function safeFileName(
  name?: string,
  mime?: string
) {
  let safe =
    (name ?? "media")
      .replace(
        /[^a-zA-Z0-9._-]/g,
        "-"
      )
      .replace(
        /-+/g,
        "-"
      )
      .slice(
        0,
        100
      );

  if (!safe.includes(".")) {
    safe +=
      extensionFromMime(
        mime
      );
  }

  return (
    safe
    ||
    `media${extensionFromMime(mime)}`
  );
}


// ======================================================
// META API HELPERS
// ======================================================

async function graphGet(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string> = {}
) {
  const url =
    new URL(
      `${baseUrl}/${path.replace(/^\/+/, "")}`
    );

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    url.searchParams.set(
      key,
      value
    );
  }

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    const message =
      (data as any)
        ?.error
        ?.message
      ??
      `Meta API GET failed with HTTP ${response.status}`;

    throw new Error(
      message
    );
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

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(
            body
          )
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    const message =
      (data as any)
        ?.error
        ?.message
      ??
      `Meta API POST failed with HTTP ${response.status}`;

    throw new Error(
      message
    );
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

  const form =
    new URLSearchParams();

  for (
    const [key, value]
    of Object.entries(body)
  ) {
    form.set(
      key,
      value
    );
  }

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          form
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    const message =
      (data as any)
        ?.error
        ?.message
      ??
      `Meta API POST failed with HTTP ${response.status}`;

    throw new Error(
      message
    );
  }

  return data;
}


// ======================================================
// INSTAGRAM — EXISTING INSTAGRAM LOGIN AUTH
// ======================================================

async function getInstagramUserId(
  env: Env
) {
  const profile =
    (await graphGet(
      INSTAGRAM_GRAPH,
      env.META_ACCESS_TOKEN,
      "me",
      {
        fields:
          "id"
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


// ======================================================
// FACEBOOK — SYSTEM USER → PAGE TOKEN
// ======================================================
//
// FACEBOOK_PAGE_ACCESS_TOKEN now contains the permanent
// System User token.
//
// Official Meta Pages flow:
//
// System User token
//       ↓
// GET /me/accounts
//       ↓
// Facebook Page Access Token
//       ↓
// /feed, /photos, /video_reels etc.
//
// ======================================================

async function getFacebookPageAccessToken(
  env: Env
) {
  const accounts =
    (await graphGet(
      FACEBOOK_GRAPH,
      env.FACEBOOK_PAGE_ACCESS_TOKEN,
      "me/accounts",
      {
        fields:
          "id,name,access_token,tasks",

        limit:
          "100"
      }
    )) as {
      data?: Array<{
        id?: string;
        name?: string;
        access_token?: string;
        tasks?: string[];
      }>;
    };

  const page =
    accounts.data?.find(
      item =>
        item.id
        ===
        FACEBOOK_PAGE_ID
    );

  if (!page) {
    throw new Error(
      `Facebook Page ${FACEBOOK_PAGE_ID} is not assigned to the System User.`
    );
  }

  if (!page.access_token) {
    throw new Error(
      `Meta did not return a Page Access Token for Facebook Page ${FACEBOOK_PAGE_ID}.`
    );
  }

  return page.access_token;
}


// ======================================================
// INSTAGRAM — FACEBOOK LOGIN AUTH FOR MUSIC
// ======================================================

function requireInstagramFacebookUserToken(
  env: Env
) {
  if (
    !env.INSTAGRAM_FB_USER_ACCESS_TOKEN
  ) {
    throw new Error(
      "Instagram Music is not configured yet. " +
      "Add the Cloudflare secret INSTAGRAM_FB_USER_ACCESS_TOKEN " +
      "using a Facebook User access token with instagram_basic " +
      "and instagram_content_publish."
    );
  }

  return (
    env.INSTAGRAM_FB_USER_ACCESS_TOKEN
  );
}


async function getFacebookLoginInstagramUserId(
  env: Env
) {
  const token =
    requireInstagramFacebookUserToken(
      env
    );

  const page =
    (await graphGet(
      FACEBOOK_GRAPH,
      token,
      FACEBOOK_PAGE_ID,
      {
        fields:
          "instagram_business_account"
      }
    )) as {
      instagram_business_account?: {
        id?: string;
      };
    };

  const igId =
    page
      ?.instagram_business_account
      ?.id;

  if (!igId) {
    throw new Error(
      "Could not resolve the Instagram Business account linked to the TBG Motors Facebook Page."
    );
  }

  return igId;
}


// ======================================================
// INSTAGRAM AUDIO HELPERS
// ======================================================

function normalizeInstagramAudio(
  item: any
) {
  return {
    audio_id:
      item?.audio_id
      ??
      item?.id
      ??
      null,

    title:
      item?.title
      ??
      null,

    display_artist:
      item?.display_artist
      ??
      null,

    duration_in_ms:
      item?.duration_in_ms
      ??
      null,

    audio_type:
      item?.audio_type
      ??
      null,

    cover_artwork_thumbnail_uri:
      item?.cover_artwork_thumbnail_uri
      ??
      item?.cover_artwork_thumbnail_url
      ??
      null,

    download_url:
      item?.download_url
      ??
      null,

    on_platform_audio_preview_link:
      item?.on_platform_audio_preview_link
      ??
      null,

    is_ads_eligible:
      item?.is_ads_eligible
      ??
      null
  };
}


// ======================================================
// MCP RESPONSE HELPERS
// ======================================================

function result(
  data: unknown
) {
  return {
    content: [
      {
        type:
          "text" as const,

        text:
          JSON.stringify(
            data,
            null,
            2
          )
      }
    ]
  };
}


function errorResult(
  error: unknown
) {
  const message =
    error instanceof Error
      ?
      error.message
      :
      "Unknown Meta API error";

  return {
    isError:
      true,

    content: [
      {
        type:
          "text" as const,

        text:
          message
      }
    ]
  };
}


// ======================================================
// MCP SERVER
// ======================================================

function createServer(
  env: Env
) {
  const server =
    new McpServer({
      name:
        "TBG Motors Social",

      version:
        "1.6.1"
    });


  // ====================================================
  // R2 — UPLOAD FILES FROM CHATGPT
  // ====================================================

  server.registerTool(
    "upload_social_media",

    ({
      title:
        "Upload social media files",

      description:
        "Upload one or more user-provided ChatGPT image/video files to TBG Motors temporary R2 media storage. Returns public HTTPS URLs that can be used for Instagram or Facebook publishing.",

      inputSchema: {
        files:
          z.array(
            OpenAIFileSchema
          )
          .min(1)
          .max(10)
      },

      annotations: {
        readOnlyHint:
          false,

        destructiveHint:
          false,

        openWorldHint:
          true
      },

      _meta: {
        "openai/fileParams": [
          "files"
        ]
      }

    } as any),

    async (
      {
        files
      }: {
        files:
          OpenAIFile[];
      }
    ) => {
      try {
        const uploaded =
          [];

        for (
          const file
          of files
        ) {
          const response =
            await fetch(
              file.download_url
            );

          if (!response.ok) {
            throw new Error(
              `Could not download ChatGPT file ${file.file_name ?? file.file_id}: HTTP ${response.status}`
            );
          }

          if (!response.body) {
            throw new Error(
              `No body returned for ${file.file_name ?? file.file_id}`
            );
          }

          const mime =
            file.mime_type
            ??
            response.headers.get(
              "content-type"
            )
            ??
            "application/octet-stream";

          const name =
            safeFileName(
              file.file_name,
              mime
            );

          const key =
            `${Date.now()}-${crypto.randomUUID()}-${name}`;

          const stored =
            await env
              .SOCIAL_MEDIA
              .put(
                key,
                response.body,
                {
                  httpMetadata: {
                    contentType:
                      mime,

                    contentDisposition:
                      "inline",

                    cacheControl:
                      "public, max-age=3600"
                  },

                  customMetadata: {
                    originalName:
                      file.file_name
                      ??
                      name,

                    chatgptFileId:
                      file.file_id
                  }
                }
              );

          uploaded.push({
            key,

            file_name:
              file.file_name
              ??
              name,

            mime_type:
              mime,

            size:
              stored.size,

            url:
              `${PUBLIC_WORKER_BASE}/media/${encodeURIComponent(key)}`
          });
        }

        return result({
          uploaded
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  server.registerTool(
    "delete_social_media_files",

    {
      description:
        "Delete temporary TBG Motors social-media files from R2 storage after they are no longer required.",

      inputSchema: {
        keys:
          z.array(
            z.string()
              .min(1)
          )
          .min(1)
          .max(20)
      },

      annotations: {
        readOnlyHint:
          false,

        destructiveHint:
          true,

        openWorldHint:
          false
      }
    },

    async ({
      keys
    }) => {
      try {
        await env
          .SOCIAL_MEDIA
          .delete(
            keys
          );

        return result({
          deleted:
            keys
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM MUSIC — SEARCH
  // ====================================================

  server.registerTool(
    "search_instagram_audio",

    {
      description:
        "Search official Instagram music using the Instagram Audio API. Read-only. Returns track metadata but never access tokens.",

      inputSchema: {
        search_query:
          z.string()
            .min(1)
            .max(200),

        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      search_query,
      limit
    }) => {
      try {
        const token =
          requireInstagramFacebookUserToken(
            env
          );

        const igId =
          await getFacebookLoginInstagramUserId(
            env
          );

        const data:
          any =
          await graphGet(
            FACEBOOK_GRAPH,
            token,
            "ig_audio",
            {
              audio_type:
                "music",

              user_id:
                igId,

              search_query
            }
          );

        const audio =
          Array.isArray(
            data?.audio
          )
            ?
            data.audio
            :
            Array.isArray(
              data?.data
            )
              ?
              data.data
              :
              [];

        return result({
          query:
            search_query,

          audio:
            audio
              .slice(
                0,
                limit
                ??
                10
              )
              .map(
                normalizeInstagramAudio
              ),

          paging:
            data?.paging
            ??
            null
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM MUSIC — TRENDING
  // ====================================================

  server.registerTool(
    "get_trending_instagram_audio",

    {
      description:
        "Get trending Instagram music using the official Instagram Audio API. Read-only.",

      inputSchema: {
        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      limit
    }) => {
      try {
        const token =
          requireInstagramFacebookUserToken(
            env
          );

        const igId =
          await getFacebookLoginInstagramUserId(
            env
          );

        const data:
          any =
          await graphGet(
            FACEBOOK_GRAPH,
            token,
            "ig_audio",
            {
              audio_type:
                "music",

              user_id:
                igId
            }
          );

        const audio =
          Array.isArray(
            data?.audio
          )
            ?
            data.audio
            :
            Array.isArray(
              data?.data
            )
              ?
              data.data
              :
              [];

        return result({
          audio:
            audio
              .slice(
                0,
                limit
                ??
                10
              )
              .map(
                normalizeInstagramAudio
              ),

          paging:
            data?.paging
            ??
            null
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM MUSIC — GET ONE TRACK
  // ====================================================

  server.registerTool(
    "get_instagram_audio",

    {
      description:
        "Get official Instagram audio metadata for one audio_id. Read-only.",

      inputSchema: {
        audio_id:
          z.string()
            .min(1)
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      audio_id
    }) => {
      try {
        const token =
          requireInstagramFacebookUserToken(
            env
          );

        const igId =
          await getFacebookLoginInstagramUserId(
            env
          );

        const data =
          await graphGet(
            FACEBOOK_GRAPH,
            token,
            audio_id,
            {
              user_id:
                igId
            }
          );

        return result(
          normalizeInstagramAudio(
            data
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK MUSIC RECOMMENDATIONS
  // ====================================================

  server.registerTool(
    "get_facebook_music_recommendations",

    {
      description:
        "Get Meta/Facebook music recommendations. Read-only. This does not attach the selected music to a Facebook Reel.",

      inputSchema: {
        type:
          z.enum([
            "FACEBOOK_POPULAR_MUSIC",
            "FACEBOOK_NEW_MUSIC",
            "FACEBOOK_FOR_YOU"
          ]),

        countries:
          z.array(
            z.string()
              .regex(
                /^[A-Za-z]{2}$/
              )
          )
          .max(10)
          .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      type,
      countries
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        const params:
          Record<
            string,
            string
          > = {
            type
          };

        if (
          countries
          &&
          countries.length
        ) {
          params.available_countries =
            countries
              .map(
                value =>
                  value
                    .toUpperCase()
              )
              .join(",");
        }

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            "audio/recommendations",
            params
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — READ
  // ====================================================

  server.registerTool(
    "get_instagram_profile",

    {
      description:
        "Get the connected TBG Motors Instagram Business profile. Read-only.",

      inputSchema:
        {},

      annotations: {
        readOnlyHint:
          true
      }
    },

    async () => {
      try {
        return result(
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            "me",
            {
              fields:
                "id,username,account_type"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
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
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      limit
    }) => {
      try {
        return result(
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            "me/media",
            {
              fields:
                "id,caption,media_type,media_product_type,permalink,timestamp",

              limit:
                String(
                  limit
                  ??
                  10
                )
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
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
          z.string()
            .min(1)
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      media_id
    }) => {
      try {
        return result(
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            media_id,
            {
              fields:
                "id,caption,media_type,media_product_type,permalink,timestamp"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
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
          z.string()
            .min(1),

        limit:
          z.number()
            .int()
            .min(1)
            .max(50)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      media_id,
      limit
    }) => {
      try {
        return result(
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${media_id}/comments`,
            {
              fields:
                "id,text,timestamp",

              limit:
                String(
                  limit
                  ??
                  20
                )
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — PHOTO CONTAINER
  // ====================================================

  server.registerTool(
    "create_instagram_photo_container",

    {
      description:
        "Prepare an Instagram PHOTO post for TBG Motors. This does NOT publish it. Static photo posts do not support Instagram Audio API music.",

      inputSchema: {
        image_url:
          z.string()
            .url(),

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
          await getInstagramUserId(
            env
          );

        const body:
          Record<
            string,
            unknown
          > = {
            image_url
          };

        if (caption) {
          body.caption =
            caption;
        }

        if (alt_text) {
          body.alt_text =
            alt_text;
        }

        if (
          is_ai_generated
          !==
          undefined
        ) {
          body.is_ai_generated =
            is_ai_generated;
        }

        return result(
          await graphPost(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${igId}/media`,
            body
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — REEL CONTAINER
  //
  // No audio_configuration:
  // existing Instagram Login flow.
  //
  // With audio_configuration:
  // Instagram API with Facebook Login.
  // ====================================================

  server.registerTool(
    "create_instagram_reel_container",

    {
      description:
        "Prepare an Instagram Reel. This does NOT publish it. When audio_configuration is supplied, official Instagram Audio API music is attached using Instagram API with Facebook Login.",

      inputSchema: {
        video_url:
          z.string()
            .url(),

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
            .optional(),

        audio_configuration:
          z.object({
            audio_id:
              z.string()
                .min(1),

            audio_volume:
              z.number()
                .int()
                .min(0)
                .max(100)
                .optional(),

            video_volume:
              z.number()
                .int()
                .min(0)
                .max(100)
                .optional(),

            should_loop_audio:
              z.boolean()
                .optional()
          })
          .optional()
      }
    },

    async ({
      video_url,
      caption,
      cover_url,
      share_to_feed,
      audio_name,
      is_ai_generated,
      audio_configuration
    }) => {
      try {

        // ----------------------------------------------
        // AUDIO API FLOW
        // ----------------------------------------------

        if (
          audio_configuration
        ) {
          if (audio_name) {
            throw new Error(
              "audio_name cannot be combined with audio_configuration."
            );
          }

          const token =
            requireInstagramFacebookUserToken(
              env
            );

          const igId =
            await getFacebookLoginInstagramUserId(
              env
            );

          const audioConfig:
            Record<
              string,
              unknown
            > = {
              audio_id:
                audio_configuration
                  .audio_id
            };

          if (
            audio_configuration
              .audio_volume
            !==
            undefined
          ) {
            audioConfig.audio_volume =
              audio_configuration
                .audio_volume;
          }

          if (
            audio_configuration
              .video_volume
            !==
            undefined
          ) {
            audioConfig.video_volume =
              audio_configuration
                .video_volume;
          }

          if (
            audio_configuration
              .should_loop_audio
            !==
            undefined
          ) {
            audioConfig.should_loop_audio =
              audio_configuration
                .should_loop_audio;
          }


          const form:
            Record<
              string,
              string
            > = {
              media_type:
                "REELS",

              video_url,

              audio_configuration:
                JSON.stringify(
                  audioConfig
                )
            };


          if (caption) {
            form.caption =
              caption;
          }

          if (cover_url) {
            form.cover_url =
              cover_url;
          }

          if (
            share_to_feed
            !==
            undefined
          ) {
            form.share_to_feed =
              String(
                share_to_feed
              );
          }

          if (
            is_ai_generated
            !==
            undefined
          ) {
            form.is_ai_generated =
              String(
                is_ai_generated
              );
          }


          const data:
            any =
            await graphPostForm(
              FACEBOOK_GRAPH,
              token,
              `${igId}/media`,
              form
            );


          return result({
            ...data,

            api_mode:
              "facebook_login",

            selected_audio_id:
              audio_configuration
                .audio_id
          });
        }


        // ----------------------------------------------
        // EXISTING INSTAGRAM LOGIN FLOW
        // ----------------------------------------------

        const igId =
          await getInstagramUserId(
            env
          );

        const body:
          Record<
            string,
            unknown
          > = {
            media_type:
              "REELS",

            video_url
          };

        if (caption) {
          body.caption =
            caption;
        }

        if (cover_url) {
          body.cover_url =
            cover_url;
        }

        if (
          share_to_feed
          !==
          undefined
        ) {
          body.share_to_feed =
            share_to_feed;
        }

        if (audio_name) {
          body.audio_name =
            audio_name;
        }

        if (
          is_ai_generated
          !==
          undefined
        ) {
          body.is_ai_generated =
            is_ai_generated;
        }


        const data:
          any =
          await graphPost(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${igId}/media`,
            body
          );


        return result({
          ...data,

          api_mode:
            "instagram_login"
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — CAROUSEL
  // ====================================================

  server.registerTool(
    "create_instagram_carousel_container",

    {
      description:
        "Prepare an Instagram carousel for TBG Motors using 2 to 10 public R2 image/video URLs. This does NOT publish it.",

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
                z.string()
                  .url(),

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
          await getInstagramUserId(
            env
          );

        const childIds:
          string[] =
          [];

        for (
          const item
          of items
        ) {
          const childBody:
            Record<
              string,
              unknown
            > = {
              is_carousel_item:
                true
            };

          if (
            item.type
            ===
            "IMAGE"
          ) {
            childBody.image_url =
              item.url;

            if (
              item.alt_text
            ) {
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
          Record<
            string,
            unknown
          > = {
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
          is_ai_generated
          !==
          undefined
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
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — CHECK CONTAINER
  // ====================================================

  server.registerTool(
    "check_instagram_container",

    {
      description:
        "Check whether an Instagram media container is ready to publish. Use api_mode=facebook_login for a Reel created with Instagram Audio API music. Read-only.",

      inputSchema: {
        container_id:
          z.string()
            .min(1),

        api_mode:
          z.enum([
            "instagram_login",
            "facebook_login"
          ])
          .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      container_id,
      api_mode
    }) => {
      try {

        if (
          api_mode
          ===
          "facebook_login"
        ) {
          const token =
            requireInstagramFacebookUserToken(
              env
            );

          return result(
            await graphGet(
              FACEBOOK_GRAPH,
              token,
              container_id,
              {
                fields:
                  "id,status_code"
              }
            )
          );
        }


        return result(
          await graphGet(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            container_id,
            {
              fields:
                "id,status_code"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // INSTAGRAM — FINAL PUBLISH
  // ====================================================

  server.registerTool(
    "publish_instagram_media",

    {
      description:
        "FINAL PUBLICATION ACTION. Publish a prepared Instagram photo, Reel or carousel. Use api_mode returned when creating an audio-enabled Reel. Only use after explicit user approval.",

      inputSchema: {
        creation_id:
          z.string()
            .min(1),

        api_mode:
          z.enum([
            "instagram_login",
            "facebook_login"
          ])
          .optional()
      }
    },

    async ({
      creation_id,
      api_mode
    }) => {
      try {

        if (
          api_mode
          ===
          "facebook_login"
        ) {
          const token =
            requireInstagramFacebookUserToken(
              env
            );

          const igId =
            await getFacebookLoginInstagramUserId(
              env
            );

          return result(
            await graphPostForm(
              FACEBOOK_GRAPH,
              token,
              `${igId}/media_publish`,
              {
                creation_id
              }
            )
          );
        }


        const igId =
          await getInstagramUserId(
            env
          );


        return result(
          await graphPost(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            `${igId}/media_publish`,
            {
              creation_id
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — READ PAGE
  // ====================================================

  server.registerTool(
    "get_facebook_page",

    {
      description:
        "Get the TBG Motors Facebook Page profile. Read-only.",

      inputSchema:
        {},

      annotations: {
        readOnlyHint:
          true
      }
    },

    async () => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            FACEBOOK_PAGE_ID,
            {
              fields:
                "id,name,link,username"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — LIST POSTS
  // ====================================================

  server.registerTool(
    "list_facebook_posts",

    {
      description:
        "List recent posts on the TBG Motors Facebook Page. Read-only.",

      inputSchema: {
        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      limit
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,

            // IMPORTANT:
            // current Meta Pages API uses /feed here
            `${FACEBOOK_PAGE_ID}/feed`,

            {
              fields:
                "id,message,created_time,permalink_url",

              limit:
                String(
                  limit
                  ??
                  10
                )
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — GET ONE POST
  // ====================================================

  server.registerTool(
    "get_facebook_post",

    {
      description:
        "Get one TBG Motors Facebook Page post by post ID. Read-only.",

      inputSchema: {
        post_id:
          z.string()
            .min(1)
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      post_id
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            post_id,
            {
              fields:
                "id,message,created_time,permalink_url"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — LIST REELS
  // ====================================================

  server.registerTool(
    "list_facebook_reels",

    {
      description:
        "List recent Reels on the TBG Motors Facebook Page. Read-only. Useful for Instagram to Facebook crossposting tests.",

      inputSchema: {
        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      limit
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/video_reels`,
            {
              limit:
                String(
                  limit
                  ??
                  10
                )
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — LIST ORDINARY VIDEOS
  // ====================================================

  server.registerTool(
    "list_facebook_videos",

    {
      description:
        "List recent ordinary videos published on the TBG Motors Facebook Page. Read-only. This is separate from Facebook Reels.",

      inputSchema: {
        limit:
          z.number()
            .int()
            .min(1)
            .max(25)
            .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      limit
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/videos`,
            {
              fields:
                "id,title,description,created_time,updated_time,permalink_url,status",

              limit:
                String(
                  limit
                  ??
                  10
                )
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — ORDINARY VIDEO POST
  // ====================================================

  server.registerTool(
    "publish_facebook_video",

    {
      description:
        "FINAL PUBLICATION ACTION. Publish a public HTTPS video URL to the TBG Motors Facebook Page as an ordinary Facebook video post, not as a Reel. The source video is sent as-is; this tool does not crop, resize, mute, add music or otherwise edit the media. Only use after explicit user approval.",

      inputSchema: {
        video_url:
          z.string()
            .url(),

        description:
          z.string()
            .optional(),

        title:
          z.string()
            .optional()
      },

      annotations: {
        readOnlyHint:
          false,

        destructiveHint:
          false,

        openWorldHint:
          true
      }
    },

    async ({
      video_url,
      description,
      title
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        const form:
          Record<
            string,
            string
          > = {
            file_url:
              video_url,

            published:
              "true"
          };

        if (description) {
          form.description =
            description;
        }

        if (title) {
          form.title =
            title;
        }

        return result(
          await graphPostForm(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/videos`,
            form
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — PREPARE PHOTO
  // ====================================================

  server.registerTool(
    "create_facebook_photo_upload",

    {
      description:
        "Upload a photo to the TBG Motors Facebook Page as unpublished media. This does NOT create a public post.",

      inputSchema: {
        image_url:
          z.string()
            .url()
      }
    },

    async ({
      image_url
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphPost(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/photos`,
            {
              url:
                image_url,

              published:
                false
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
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
        "FINAL PUBLICATION ACTION. Publish 1 to 10 previously prepared Facebook photos as a TBG Motors Page post. Only use after explicit user approval.",

      inputSchema: {
        photo_ids:
          z.array(
            z.string()
              .min(1)
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
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        const form:
          Record<
            string,
            string
          > = {};


        if (message) {
          form.message =
            message;
        }


        photo_ids.forEach(
          (
            id,
            index
          ) => {
            form[
              `attached_media[${index}]`
            ] =
              JSON.stringify({
                media_fbid:
                  id
              });
          }
        );


        return result(
          await graphPostForm(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/feed`,
            form
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
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
        "FINAL PUBLICATION ACTION. Publish a text or link post to the public TBG Motors Facebook Page. Only use after explicit user approval.",

      inputSchema: {
        message:
          z.string()
            .min(1),

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
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        const body:
          Record<
            string,
            unknown
          > = {
            message,

            published:
              true
          };


        if (link) {
          body.link =
            link;
        }


        return result(
          await graphPost(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/feed`,
            body
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — PREPARE REEL
  // ====================================================

  server.registerTool(
    "create_facebook_reel_upload",

    {
      description:
        "Prepare and upload a Facebook Reel for TBG Motors from a public HTTPS video URL. This does NOT publish it. The Worker downloads the source and sends the video bytes directly to Meta's Reel upload endpoint, which is more reliable than asking Meta to fetch the hosted URL.",

      inputSchema: {
        video_url:
          z.string()
            .url()
      }
    },

    async ({
      video_url
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );


        const start =
          (await graphPost(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/video_reels`,
            {
              upload_phase:
                "start"
            }
          )) as {
            video_id?: string;
            upload_url?: string;
          };


        if (
          !start.video_id
          ||
          !start.upload_url
        ) {
          throw new Error(
            "Meta did not return a Facebook Reel video_id and upload_url."
          );
        }


        let videoBytes:
          ArrayBuffer;


        const sourceUrl =
          new URL(
            video_url
          );


        if (
          sourceUrl.origin
          ===
          PUBLIC_WORKER_BASE
          &&
          sourceUrl.pathname
            .startsWith(
              "/media/"
            )
        ) {
          const encodedKey =
            sourceUrl.pathname
              .replace(
                /^\/media\//,
                ""
              );


          const key =
            decodeURIComponent(
              encodedKey
            );


          const object =
            await env
              .SOCIAL_MEDIA
              .get(
                key
              );


          if (
            !object
            ||
            !("body" in object)
          ) {
            throw new Error(
              `Could not read Reel source from R2: ${key}`
            );
          }


          videoBytes =
            await object
              .arrayBuffer();

        } else {
          const sourceResponse =
            await fetch(
              video_url,
              {
                method:
                  "GET"
              }
            );


          if (
            !sourceResponse.ok
          ) {
            throw new Error(
              `Could not download Reel source video: HTTP ${sourceResponse.status}`
            );
          }


          videoBytes =
            await sourceResponse
              .arrayBuffer();
        }


        if (
          videoBytes.byteLength
          ===
          0
        ) {
          throw new Error(
            "The Reel source video is empty."
          );
        }


        const uploadResponse =
          await fetch(
            start.upload_url,
            {
              method:
                "POST",

              headers: {
                Authorization:
                  `OAuth ${pageToken}`,

                offset:
                  "0",

                file_size:
                  String(
                    videoBytes.byteLength
                  ),

                "Content-Type":
                  "application/octet-stream"
              },

              body:
                videoBytes
            }
          );


        const uploadText =
          await uploadResponse
            .text();


        let uploadData:
          any;

        try {
          uploadData =
            uploadText
              ?
              JSON.parse(
                uploadText
              )
              :
              {};
        } catch {
          uploadData = {
            raw:
              uploadText
          };
        }


        if (
          !uploadResponse.ok
        ) {
          const metaMessage =
            uploadData
              ?.error
              ?.message
            ??
            uploadData
              ?.debug_info
              ?.message
            ??
            uploadData
              ?.message
            ??
            uploadText
            ??
            "Unknown upload error";

          throw new Error(
            `Facebook Reel upload failed with HTTP ${uploadResponse.status}: ${metaMessage}`
          );
        }


        return result({
          video_id:
            start.video_id,

          source_bytes:
            videoBytes.byteLength,

          upload_result:
            uploadData
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — CHECK REEL
  // ====================================================

  server.registerTool(
    "check_facebook_reel",

    {
      description:
        "Check processing status of a prepared Facebook Reel. Read-only.",

      inputSchema: {
        video_id:
          z.string()
            .min(1)
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      video_id
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphGet(
            FACEBOOK_GRAPH,
            pageToken,
            video_id,
            {
              fields:
                "id,status"
            }
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // FACEBOOK — FINAL REEL PUBLISH
  // ====================================================

  server.registerTool(
    "publish_facebook_reel",

    {
      description:
        "FINAL PUBLICATION ACTION. Publish a previously uploaded Facebook Reel to the public TBG Motors Facebook Page. Only use after explicit user approval.",

      inputSchema: {
        video_id:
          z.string()
            .min(1),

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
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );


        const body:
          Record<
            string,
            unknown
          > = {
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


        return result(
          await graphPost(
            FACEBOOK_GRAPH,
            pageToken,
            `${FACEBOOK_PAGE_ID}/video_reels`,
            body
          )
        );

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  return server;
}


// ======================================================
// PUBLIC R2 MEDIA ROUTE
// ======================================================

async function serveMedia(
  request: Request,
  env: Env
) {
  const url =
    new URL(
      request.url
    );


  const encodedKey =
    url.pathname
      .replace(
        /^\/media\//,
        ""
      );


  if (!encodedKey) {
    return new Response(
      "Missing media key",
      {
        status:
          400
      }
    );
  }


  const key =
    decodeURIComponent(
      encodedKey
    );


  if (
    request.method
    ===
    "HEAD"
  ) {
    const object =
      await env
        .SOCIAL_MEDIA
        .head(
          key
        );


    if (!object) {
      return new Response(
        null,
        {
          status:
            404
        }
      );
    }


    const headers =
      new Headers();


    object.writeHttpMetadata(
      headers
    );


    headers.set(
      "etag",
      object.httpEtag
    );


    headers.set(
      "content-length",
      String(
        object.size
      )
    );


    headers.set(
      "accept-ranges",
      "bytes"
    );


    return new Response(
      null,
      {
        status:
          200,

        headers
      }
    );
  }


  if (
    request.method
    !==
    "GET"
  ) {
    return new Response(
      "Method Not Allowed",
      {
        status:
          405,

        headers: {
          Allow:
            "GET, HEAD"
        }
      }
    );
  }


  const object =
    await env
      .SOCIAL_MEDIA
      .get(
        key,
        {
          onlyIf:
            request.headers,

          range:
            request.headers
        }
      );


  if (!object) {
    return new Response(
      "Object Not Found",
      {
        status:
          404
      }
    );
  }


  const headers =
    new Headers();


  object.writeHttpMetadata(
    headers
  );


  headers.set(
    "etag",
    object.httpEtag
  );


  headers.set(
    "accept-ranges",
    "bytes"
  );


  headers.set(
    "access-control-allow-origin",
    "*"
  );


  if (!("body" in object)) {
    return new Response(
      null,
      {
        status:
          412,

        headers
      }
    );
  }


  let status =
    200;


  if (
    object.range
    &&
    typeof object.range.offset
      ===
      "number"
    &&
    typeof object.range.length
      ===
      "number"
  ) {
    const start =
      object.range.offset;


    const end =
      start
      +
      object.range.length
      -
      1;


    headers.set(
      "content-range",
      `bytes ${start}-${end}/${object.size}`
    );


    headers.set(
      "content-length",
      String(
        object.range.length
      )
    );


    status =
      206;
  }


  return new Response(
    object.body,
    {
      status,
      headers
    }
  );
}


// ======================================================
// CLOUDFLARE ENTRY
// ======================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {
    const url =
      new URL(
        request.url
      );


    if (
      url.pathname
        .startsWith(
          "/media/"
        )
    ) {
      return serveMedia(
        request,
        env as Env
      );
    }


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
