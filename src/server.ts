import { DurableObject } from "cloudflare:workers";
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

  // Cloudflare Images binding for crop/resize/image preparation.
  IMAGES: any;

  // Cloudflare Media Transformations binding for trim/resize/video preparation.
  MEDIA: any;

  // Durable Object scheduler for future Instagram/Facebook publication jobs.
  SOCIAL_SCHEDULER: any;
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

const TBG_SOLD_STAMP_KEY =
  "1791033426610-12d3afff-b02e-4168-bccf-7aa38838f2ea-tbg-sold-stamp.png";


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



function getR2KeyFromPublicMediaUrl(
  mediaUrl: string
) {
  try {
    const url =
      new URL(
        mediaUrl
      );

    if (
      url.origin
      !==
      PUBLIC_WORKER_BASE
      ||
      !url.pathname
        .startsWith(
          "/media/"
        )
    ) {
      return null;
    }

    return decodeURIComponent(
      url.pathname
        .replace(
          /^\/media\//,
          ""
        )
    );

  } catch {
    return null;
  }
}


async function getMediaInput(
  env: Env,
  mediaUrl: string
) {
  const key =
    getR2KeyFromPublicMediaUrl(
      mediaUrl
    );

  if (key) {
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
        `Media object not found in R2: ${key}`
      );
    }

    return {
      body:
        object.body,
      contentType:
        object.httpMetadata
          ?.contentType
        ??
        "application/octet-stream",
      sourceKey:
        key
    };
  }


  const response =
    await fetch(
      mediaUrl
    );

  if (
    !response.ok
    ||
    !response.body
  ) {
    throw new Error(
      `Could not download media source: HTTP ${response.status}`
    );
  }

  return {
    body:
      response.body,
    contentType:
      response.headers
        .get(
          "content-type"
        )
      ??
      "application/octet-stream",
    sourceKey:
      null
  };
}


async function storeProcessedMedia(
  env: Env,
  prefix: string,
  extension: string,
  contentType: string,
  body: ReadableStream<Uint8Array>
) {
  const key =
    `processed/${Date.now()}-${crypto.randomUUID()}-${prefix}${extension}`;

  const stored =
    await env
      .SOCIAL_MEDIA
      .put(
        key,
        body,
        {
          httpMetadata: {
            contentType,
            contentDisposition:
              "inline",
            cacheControl:
              "public, max-age=3600"
          },
          customMetadata: {
            processed:
              "true"
          }
        }
      );

  return {
    key,
    size:
      stored.size,
    mime_type:
      contentType,
    url:
      `${PUBLIC_WORKER_BASE}/media/${encodeURIComponent(key)}`
  };
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



async function graphDelete(
  baseUrl: string,
  token: string,
  path: string
) {
  const url =
    `${baseUrl}/${path.replace(/^\/+/, "")}`;

  const response =
    await fetch(
      url,
      {
        method:
          "DELETE",

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  const text =
    await response
      .text();

  let data:
    any;

  try {
    data =
      text
        ?
        JSON.parse(
          text
        )
        :
        {
          success:
            response.ok
        };
  } catch {
    data = {
      success:
        response.ok,
      raw:
        text
    };
  }

  if (
    !response.ok
  ) {
    const message =
      data
        ?.error
        ?.message
      ??
      `Meta API DELETE failed with HTTP ${response.status}`;

    throw new Error(
      message
    );
  }

  return data;
}


async function setFacebookPreferredThumbnailFromUrl(
  env: Env,
  pageToken: string,
  videoId: string,
  imageUrl: string
) {
  const source =
    await getMediaInput(
      env,
      imageUrl
    );

  const bytes =
    await new Response(
      source.body
    )
      .arrayBuffer();

  if (
    bytes.byteLength
    ===
    0
  ) {
    throw new Error(
      "Facebook thumbnail source image is empty."
    );
  }

  const form =
    new FormData();

  form.append(
    "source",
    new Blob(
      [
        bytes
      ],
      {
        type:
          source.contentType
          ||
          "image/jpeg"
      }
    ),
    "thumbnail.jpg"
  );

  form.append(
    "is_preferred",
    "true"
  );

  const response =
    await fetch(
      `${FACEBOOK_GRAPH}/${videoId}/thumbnails`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${pageToken}`
        },

        body:
          form
      }
    );

  const data =
    await response
      .json();

  if (
    !response.ok
  ) {
    const message =
      (data as any)
        ?.error
        ?.message
      ??
      `Facebook thumbnail upload failed with HTTP ${response.status}`;

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



type SocialScheduleContent = {
  platforms: Array<
    "instagram"
    |
    "facebook"
  >;

  content_type:
    "photo"
    |
    "reel"
    |
    "video"
    |
    "text";

  caption?: string;
  title?: string;
  image_urls?: string[];
  video_url?: string;
  cover_url?: string;
  share_to_feed?: boolean;

  audio_configuration?: {
    audio_id: string;
    audio_volume?: number;
    video_volume?: number;
    should_loop_audio?: boolean;
  };
};


type SocialScheduleJob = {
  id: string;
  scheduled_at: string;
  next_run_at: string;
  status:
    "scheduled"
    |
    "processing"
    |
    "completed"
    |
    "cancelled"
    |
    "failed";
  content: SocialScheduleContent;
  progress: Record<string, any>;
  created_at: string;
  updated_at: string;
  error?: string;
};


async function uploadFacebookReelBytes(
  env: Env,
  pageToken: string,
  videoUrl: string
) {
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


  const source =
    await getMediaInput(
      env,
      videoUrl
    );


  const bytes =
    await new Response(
      source.body
    )
      .arrayBuffer();


  if (
    bytes.byteLength
    ===
    0
  ) {
    throw new Error(
      "Facebook Reel source video is empty."
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
              bytes.byteLength
            ),

          "Content-Type":
            "application/octet-stream"
        },

        body:
          bytes
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
    const message =
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
      `Facebook Reel upload failed with HTTP ${uploadResponse.status}`;

    throw new Error(
      String(
        message
      )
    );
  }


  return {
    video_id:
      start.video_id,

    upload_result:
      uploadData
  };
}


async function publishScheduledFacebook(
  env: Env,
  content: SocialScheduleContent
) {
  const pageToken =
    await getFacebookPageAccessToken(
      env
    );


  if (
    content.content_type
    ===
    "text"
  ) {
    if (
      !content.caption
    ) {
      throw new Error(
        "Facebook text post requires caption."
      );
    }

    return await graphPost(
      FACEBOOK_GRAPH,
      pageToken,
      `${FACEBOOK_PAGE_ID}/feed`,
      {
        message:
          content.caption,

        published:
          true
      }
    );
  }


  if (
    content.content_type
    ===
    "photo"
  ) {
    const urls =
      content.image_urls
      ??
      [];

    if (
      urls.length
      <
      1
      ||
      urls.length
      >
      10
    ) {
      throw new Error(
        "Facebook photo post requires 1 to 10 image URLs."
      );
    }


    const ids:
      string[] =
      [];


    for (
      const imageUrl
      of urls
    ) {
      const prepared =
        (await graphPost(
          FACEBOOK_GRAPH,
          pageToken,
          `${FACEBOOK_PAGE_ID}/photos`,
          {
            url:
              imageUrl,

            published:
              false
          }
        )) as {
          id?: string;
        };


      if (
        !prepared.id
      ) {
        throw new Error(
          "Meta did not return a Facebook photo ID."
        );
      }


      ids.push(
        prepared.id
      );
    }


    const form:
      Record<
        string,
        string
      > = {};


    if (
      content.caption
    ) {
      form.message =
        content.caption;
    }


    ids.forEach(
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


    return await graphPostForm(
      FACEBOOK_GRAPH,
      pageToken,
      `${FACEBOOK_PAGE_ID}/feed`,
      form
    );
  }


  if (
    !content.video_url
  ) {
    throw new Error(
      "Facebook video/Reel schedule requires video_url."
    );
  }


  if (
    content.content_type
    ===
    "video"
  ) {
    const form:
      Record<
        string,
        string
      > = {
        file_url:
          content.video_url,

        published:
          "true"
      };


    if (
      content.caption
    ) {
      form.description =
        content.caption;
    }


    if (
      content.title
    ) {
      form.title =
        content.title;
    }


    return await graphPostForm(
      FACEBOOK_GRAPH,
      pageToken,
      `${FACEBOOK_PAGE_ID}/videos`,
      form
    );
  }


  const prepared =
    await uploadFacebookReelBytes(
      env,
      pageToken,
      content.video_url
    );


  const publishBody:
    Record<
      string,
      unknown
    > = {
      video_id:
        prepared.video_id,

      upload_phase:
        "finish",

      video_state:
        "PUBLISHED"
    };


  if (
    content.caption
  ) {
    publishBody.description =
      content.caption;
  }


  if (
    content.title
  ) {
    publishBody.title =
      content.title;
  }


  const published =
    await graphPost(
      FACEBOOK_GRAPH,
      pageToken,
      `${FACEBOOK_PAGE_ID}/video_reels`,
      publishBody
    );


  let thumbnail:
    any =
    null;


  if (
    content.cover_url
  ) {
    try {
      thumbnail =
        await setFacebookPreferredThumbnailFromUrl(
          env,
          pageToken,
          prepared.video_id,
          content.cover_url
        );
    } catch (
      error
    ) {
      thumbnail = {
        warning:
          error instanceof Error
            ?
            error.message
            :
            "Could not set Facebook thumbnail."
      };
    }
  }


  return {
    ...published as any,

    video_id:
      prepared.video_id,

    thumbnail
  };
}


async function createScheduledInstagramContainer(
  env: Env,
  content: SocialScheduleContent
) {
  if (
    content.content_type
    ===
    "text"
  ) {
    throw new Error(
      "Instagram does not support text-only publishing."
    );
  }


  if (
    content.content_type
    ===
    "photo"
  ) {
    const urls =
      content.image_urls
      ??
      [];


    if (
      urls.length
      <
      1
      ||
      urls.length
      >
      10
    ) {
      throw new Error(
        "Instagram photo schedule requires 1 to 10 image URLs."
      );
    }


    const igId =
      await getInstagramUserId(
        env
      );


    if (
      urls.length
      ===
      1
    ) {
      const data:
        any =
        await graphPost(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${igId}/media`,
          {
            image_url:
              urls[0],

            ...(content.caption
              ?
              {
                caption:
                  content.caption
              }
              :
              {})
          }
        );


      return {
        creation_id:
          data.id,

        api_mode:
          "instagram_login"
      };
    }


    const childIds:
      string[] =
      [];


    for (
      const imageUrl
      of urls
    ) {
      const child:
        any =
        await graphPost(
          INSTAGRAM_GRAPH,
          env.META_ACCESS_TOKEN,
          `${igId}/media`,
          {
            image_url:
              imageUrl,

            is_carousel_item:
              true
          }
        );


      if (
        !child.id
      ) {
        throw new Error(
          "Meta did not return an Instagram carousel child ID."
        );
      }


      childIds.push(
        child.id
      );
    }


    const parent:
      any =
      await graphPost(
        INSTAGRAM_GRAPH,
        env.META_ACCESS_TOKEN,
        `${igId}/media`,
        {
          media_type:
            "CAROUSEL",

          children:
            childIds.join(","),

          ...(content.caption
            ?
            {
              caption:
                content.caption
            }
            :
            {})
        }
      );


    return {
      creation_id:
        parent.id,

      api_mode:
        "instagram_login"
    };
  }


  if (
    !content.video_url
  ) {
    throw new Error(
      "Instagram Reel schedule requires video_url."
    );
  }


  if (
    content.audio_configuration
  ) {
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
          content
            .audio_configuration
            .audio_id
      };


    if (
      content
        .audio_configuration
        .audio_volume
      !==
      undefined
    ) {
      audioConfig.audio_volume =
        content
          .audio_configuration
          .audio_volume;
    }


    if (
      content
        .audio_configuration
        .video_volume
      !==
      undefined
    ) {
      audioConfig.video_volume =
        content
          .audio_configuration
          .video_volume;
    }


    if (
      content
        .audio_configuration
        .should_loop_audio
      !==
      undefined
    ) {
      audioConfig.should_loop_audio =
        content
          .audio_configuration
          .should_loop_audio;
    }


    const form:
      Record<
        string,
        string
      > = {
        media_type:
          "REELS",

        video_url:
          content.video_url,

        audio_configuration:
          JSON.stringify(
            audioConfig
          )
      };


    if (
      content.caption
    ) {
      form.caption =
        content.caption;
    }


    if (
      content.cover_url
    ) {
      form.cover_url =
        content.cover_url;
    }


    if (
      content.share_to_feed
      !==
      undefined
    ) {
      form.share_to_feed =
        String(
          content.share_to_feed
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


    return {
      creation_id:
        data.id,

      api_mode:
        "facebook_login"
    };
  }


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

      video_url:
        content.video_url
    };


  if (
    content.caption
  ) {
    body.caption =
      content.caption;
  }


  if (
    content.cover_url
  ) {
    body.cover_url =
      content.cover_url;
  }


  if (
    content.share_to_feed
    !==
    undefined
  ) {
    body.share_to_feed =
      content.share_to_feed;
  }


  const data:
    any =
    await graphPost(
      INSTAGRAM_GRAPH,
      env.META_ACCESS_TOKEN,
      `${igId}/media`,
      body
    );


  return {
    creation_id:
      data.id,

    api_mode:
      "instagram_login"
  };
}


async function checkScheduledInstagramContainer(
  env: Env,
  creationId: string,
  apiMode: string
) {
  if (
    apiMode
    ===
    "facebook_login"
  ) {
    const token =
      requireInstagramFacebookUserToken(
        env
      );


    return await graphGet(
      FACEBOOK_GRAPH,
      token,
      creationId,
      {
        fields:
          "id,status_code"
      }
    );
  }


  return await graphGet(
    INSTAGRAM_GRAPH,
    env.META_ACCESS_TOKEN,
    creationId,
    {
      fields:
        "id,status_code"
    }
  );
}


async function publishScheduledInstagramContainer(
  env: Env,
  creationId: string,
  apiMode: string
) {
  if (
    apiMode
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


    return await graphPostForm(
      FACEBOOK_GRAPH,
      token,
      `${igId}/media_publish`,
      {
        creation_id:
          creationId
      }
    );
  }


  const igId =
    await getInstagramUserId(
      env
    );


  return await graphPost(
    INSTAGRAM_GRAPH,
    env.META_ACCESS_TOKEN,
    `${igId}/media_publish`,
    {
      creation_id:
        creationId
    }
  );
}


async function runScheduledSocialJob(
  env: Env,
  job: SocialScheduleJob
) {
  const progress =
    job.progress
    ??
    {};


  for (
    const platform
    of job.content.platforms
  ) {
    if (
      progress[
        platform
      ]
        ?.status
      ===
      "completed"
    ) {
      continue;
    }


    if (
      platform
      ===
      "facebook"
    ) {
      const published =
        await publishScheduledFacebook(
          env,
          job.content
        );


      progress.facebook = {
        status:
          "completed",

        result:
          published
      };


      continue;
    }


    const instagram =
      progress.instagram
      ??
      {
        status:
          "not_started",

        poll_attempts:
          0
      };


    if (
      !instagram.creation_id
    ) {
      const prepared =
        await createScheduledInstagramContainer(
          env,
          job.content
        );


      instagram.creation_id =
        prepared.creation_id;

      instagram.api_mode =
        prepared.api_mode;

      instagram.status =
        "processing";

      instagram.poll_attempts =
        0;

      progress.instagram =
        instagram;


      return {
        completed:
          false,

        progress,

        next_run_at:
          new Date(
            Date.now()
            +
            15_000
          )
            .toISOString()
      };
    }


    const checked:
      any =
      await checkScheduledInstagramContainer(
        env,
        instagram.creation_id,
        instagram.api_mode
      );


    if (
      checked
        ?.status_code
      ===
      "FINISHED"
    ) {
      const published =
        await publishScheduledInstagramContainer(
          env,
          instagram.creation_id,
          instagram.api_mode
        );


      progress.instagram = {
        ...instagram,

        status:
          "completed",

        result:
          published
      };


      continue;
    }


    if (
      checked
        ?.status_code
      ===
      "ERROR"
    ) {
      throw new Error(
        "Instagram scheduled media container failed processing."
      );
    }


    instagram.poll_attempts =
      (
        instagram.poll_attempts
        ??
        0
      )
      +
      1;


    if (
      instagram.poll_attempts
      >
      40
    ) {
      throw new Error(
        "Instagram scheduled media did not finish processing in time."
      );
    }


    instagram.status =
      "processing";

    progress.instagram =
      instagram;


    return {
      completed:
        false,

      progress,

      next_run_at:
        new Date(
          Date.now()
          +
          15_000
        )
          .toISOString()
    };
  }


  return {
    completed:
      true,

    progress,

    next_run_at:
      job.next_run_at
  };
}


async function schedulerRequest(
  env: Env,
  method: string,
  path: string,
  body?: unknown
) {
  const scheduler =
    env
      .SOCIAL_SCHEDULER
      .getByName(
        "tbg-motors-social"
      );


  const response =
    await scheduler
      .fetch(
        new Request(
          `https://scheduler${path}`,
          {
            method,

            headers:
              body
                ?
                {
                  "Content-Type":
                    "application/json"
                }
                :
                undefined,

            body:
              body
                ?
                JSON.stringify(
                  body
                )
                :
                undefined
          }
        )
      );


  const data =
    await response
      .json();


  if (
    !response.ok
  ) {
    throw new Error(
      (data as any)
        ?.error
      ??
      `Scheduler failed with HTTP ${response.status}`
    );
  }


  return data;
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
        "2.0.0"
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
  // MEDIA PROCESSING — IMAGE
  // ====================================================

  server.registerTool(
    "process_social_image",

    {
      description:
        "Prepare an image for TBG Motors social media using Cloudflare Images. Can crop/resize for Instagram or Facebook and optionally add a large SOLD label. The original R2 file is never modified; a processed copy is stored in R2.",

      inputSchema: {
        image_url:
          z.string()
            .url(),

        preset:
          z.enum([
            "instagram_portrait",
            "instagram_square",
            "story_reel_cover",
            "facebook_portrait",
            "facebook_landscape",
            "custom"
          ])
          .default(
            "instagram_portrait"
          ),

        width:
          z.number()
            .int()
            .min(50)
            .max(3000)
            .optional(),

        height:
          z.number()
            .int()
            .min(50)
            .max(3000)
            .optional(),

        fit:
          z.enum([
            "cover",
            "contain",
            "scale-down"
          ])
          .optional(),

        quality:
          z.number()
            .int()
            .min(40)
            .max(100)
            .optional(),

        sold:
          z.boolean()
            .optional(),

        sold_text:
          z.string()
            .min(1)
            .max(40)
            .optional()
      },

      annotations: {
        readOnlyHint:
          false,
        destructiveHint:
          false,
        openWorldHint:
          false
      }
    },

    async ({
      image_url,
      preset,
      width,
      height,
      fit,
      quality,
      sold,
      sold_text
    }) => {
      try {
        const presets:
          Record<
            string,
            {
              width: number;
              height: number;
              fit: string;
            }
          > = {
            instagram_portrait: {
              width:
                1080,
              height:
                1350,
              fit:
                "cover"
            },
            instagram_square: {
              width:
                1080,
              height:
                1080,
              fit:
                "cover"
            },
            story_reel_cover: {
              width:
                1080,
              height:
                1920,
              fit:
                "cover"
            },
            facebook_portrait: {
              width:
                1080,
              height:
                1350,
              fit:
                "cover"
            },
            facebook_landscape: {
              width:
                1200,
              height:
                630,
              fit:
                "cover"
            },
            custom: {
              width:
                width
                ??
                1080,
              height:
                height
                ??
                1350,
              fit:
                fit
                ??
                "cover"
            }
          };


        const selected =
          presets[
            preset
          ];


        const targetWidth =
          preset
          ===
          "custom"
            ?
            width
            ??
            selected.width
            :
            selected.width;


        const targetHeight =
          preset
          ===
          "custom"
            ?
            height
            ??
            selected.height
            :
            selected.height;


        const targetFit =
          fit
          ??
          selected.fit;


        const source =
          await getMediaInput(
            env,
            image_url
          );


        let pipeline:
          any =
          env
            .IMAGES
            .input(
              source.body
            )
            .transform({
              width:
                targetWidth,
              height:
                targetHeight,
              fit:
                targetFit
            });


        if (sold) {
          if (
            sold_text
            &&
            sold_text
              .trim()
              .toUpperCase()
            !==
            "SOLD"
          ) {
            throw new Error(
              "The TBG Motors SOLD template uses the fixed text SOLD so every sold post stays visually consistent."
            );
          }


          const stampObject =
            await env
              .SOCIAL_MEDIA
              .get(
                TBG_SOLD_STAMP_KEY
              );


          if (
            !stampObject
            ||
            !("body" in stampObject)
          ) {
            throw new Error(
              "The standard TBG Motors SOLD stamp asset is missing from R2."
            );
          }


          // Standard TBG Motors SOLD layout:
          // - exact same distressed red/white stamp asset every time
          // - 46% of the final image width
          // - horizontally centred
          // - vertically centred in the Instagram/Facebook safe area
          //
          // Keeping these ratios fixed makes SOLD posts line up consistently
          // in the Instagram profile grid and on Facebook.
          const stampWidth =
            Math.round(
              targetWidth
              *
              0.46
            );


          const stampHeight =
            Math.round(
              stampWidth
              *
              584
              /
              1248
            );


          const stampLeft =
            Math.round(
              (
                targetWidth
                -
                stampWidth
              )
              /
              2
            );


          const stampTop =
            Math.round(
              targetHeight
              *
              0.50
              -
              stampHeight
              /
              2
            );


          const stamp =
            env
              .IMAGES
              .input(
                stampObject.body
              )
              .transform({
                width:
                  stampWidth
              });


          pipeline =
            pipeline
              .draw(
                stamp,
                {
                  top:
                    stampTop,
                  left:
                    stampLeft,
                  opacity:
                    0.98
                }
              );
        }


        const output =
          await pipeline
            .output({
              format:
                "image/jpeg",
              quality:
                quality
                ??
                90
            });


        const response =
          output
            .response();


        if (
          !response.body
        ) {
          throw new Error(
            "Cloudflare Images returned no image body."
          );
        }


        const stored =
          await storeProcessedMedia(
            env,
            sold
              ?
              "sold-image"
              :
              "social-image",
            ".jpg",
            "image/jpeg",
            response.body
          );


        return result({
          ...stored,
          preset,
          width:
            targetWidth,
          height:
            targetHeight,
          fit:
            targetFit,
          sold:
            Boolean(
              sold
            ),
          original_preserved:
            true
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // MEDIA PROCESSING — VIDEO
  // ====================================================

  server.registerTool(
    "process_social_video",

    {
      description:
        "Prepare one video for social media using Cloudflare Media Transformations. Supports trimming, resizing/cropping to 9:16 or other presets, and keeping or removing the original audio. The original file is preserved and the processed MP4 is stored in R2. This tool does not concatenate multiple clips or mix a music track yet.",

      inputSchema: {
        video_url:
          z.string()
            .url(),

        preset:
          z.enum([
            "reel_9_16",
            "square_1_1",
            "portrait_4_5",
            "landscape_16_9",
            "custom"
          ])
          .default(
            "reel_9_16"
          ),

        width:
          z.number()
            .int()
            .min(50)
            .max(2000)
            .optional(),

        height:
          z.number()
            .int()
            .min(50)
            .max(2000)
            .optional(),

        fit:
          z.enum([
            "cover",
            "contain",
            "scale-down"
          ])
          .optional(),

        start_seconds:
          z.number()
            .min(0)
            .max(600)
            .optional(),

        duration_seconds:
          z.number()
            .min(1)
            .max(60)
            .optional(),

        keep_original_audio:
          z.boolean()
            .optional()
      },

      annotations: {
        readOnlyHint:
          false,
        destructiveHint:
          false,
        openWorldHint:
          false
      }
    },

    async ({
      video_url,
      preset,
      width,
      height,
      fit,
      start_seconds,
      duration_seconds,
      keep_original_audio
    }) => {
      try {
        const presets:
          Record<
            string,
            {
              width: number;
              height: number;
              fit: string;
            }
          > = {
            reel_9_16: {
              width:
                1080,
              height:
                1920,
              fit:
                "cover"
            },
            square_1_1: {
              width:
                1080,
              height:
                1080,
              fit:
                "cover"
            },
            portrait_4_5: {
              width:
                1080,
              height:
                1350,
              fit:
                "cover"
            },
            landscape_16_9: {
              width:
                1920,
              height:
                1080,
              fit:
                "contain"
            },
            custom: {
              width:
                width
                ??
                1080,
              height:
                height
                ??
                1920,
              fit:
                fit
                ??
                "cover"
            }
          };


        const selected =
          presets[
            preset
          ];


        const targetWidth =
          preset
          ===
          "custom"
            ?
            width
            ??
            selected.width
            :
            selected.width;


        const targetHeight =
          preset
          ===
          "custom"
            ?
            height
            ??
            selected.height
            :
            selected.height;


        const targetFit =
          fit
          ??
          selected.fit;


        const source =
          await getMediaInput(
            env,
            video_url
          );


        const outputOptions:
          Record<
            string,
            unknown
          > = {
            mode:
              "video",
            audio:
              keep_original_audio
              ??
              true
          };


        if (
          start_seconds
          !==
          undefined
        ) {
          outputOptions.time =
            `${start_seconds}s`;
        }


        if (
          duration_seconds
          !==
          undefined
        ) {
          outputOptions.duration =
            `${duration_seconds}s`;
        }


        const transformed =
          env
            .MEDIA
            .input(
              source.body
            )
            .transform({
              width:
                targetWidth,
              height:
                targetHeight,
              fit:
                targetFit
            })
            .output(
              outputOptions
            );


        const contentType =
          await transformed
            .contentType();


        const media =
          await transformed
            .media();


        const stored =
          await storeProcessedMedia(
            env,
            "social-video",
            ".mp4",
            contentType
              ||
              "video/mp4",
            media
          );


        return result({
          ...stored,
          preset,
          width:
            targetWidth,
          height:
            targetHeight,
          fit:
            targetFit,
          start_seconds:
            start_seconds
            ??
            0,
          duration_seconds:
            duration_seconds
            ??
            null,
          keep_original_audio:
            keep_original_audio
            ??
            true,
          original_preserved:
            true
        });

      } catch (error) {
        return errorResult(
          error
        );
      }
    }
  );


  // ====================================================
  // MEDIA PROCESSING — VIDEO FRAME / COVER
  // ====================================================

  server.registerTool(
    "extract_social_video_frame",

    {
      description:
        "Extract a JPEG still frame from a video for a Reel cover or social thumbnail. Stores the frame in R2 and returns its public URL.",

      inputSchema: {
        video_url:
          z.string()
            .url(),

        time_seconds:
          z.number()
            .min(0)
            .max(600)
            .default(
              1
            ),

        width:
          z.number()
            .int()
            .min(50)
            .max(2000)
            .optional(),

        height:
          z.number()
            .int()
            .min(50)
            .max(2000)
            .optional(),

        fit:
          z.enum([
            "cover",
            "contain",
            "scale-down"
          ])
          .optional()
      },

      annotations: {
        readOnlyHint:
          false,
        destructiveHint:
          false,
        openWorldHint:
          false
      }
    },

    async ({
      video_url,
      time_seconds,
      width,
      height,
      fit
    }) => {
      try {
        const source =
          await getMediaInput(
            env,
            video_url
          );


        let media:
          any =
          env
            .MEDIA
            .input(
              source.body
            );


        if (
          width
          ||
          height
        ) {
          media =
            media
              .transform({
                width:
                  width
                  ??
                  1080,
                height:
                  height
                  ??
                  1920,
                fit:
                  fit
                  ??
                  "cover"
              });
        }


        const frame =
          media
            .output({
              mode:
                "frame",
              time:
                `${time_seconds}s`,
              format:
                "jpg"
            });


        const contentType =
          await frame
            .contentType();


        const body =
          await frame
            .media();


        const stored =
          await storeProcessedMedia(
            env,
            "video-cover",
            ".jpg",
            contentType
              ||
              "image/jpeg",
            body
          );


        return result({
          ...stored,
          time_seconds,
          original_preserved:
            true
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


  // ====================================================
  // FACEBOOK — CUSTOM VIDEO / REEL THUMBNAIL
  // ====================================================

  server.registerTool(
    "set_facebook_video_thumbnail",

    {
      description:
        "FINAL MEDIA CHANGE. Set a custom preferred thumbnail/cover image for a TBG Motors Facebook video or Reel using Meta's Video Thumbnails API. Useful for the standard SOLD cover. Only use after explicit user approval.",

      inputSchema: {
        video_id:
          z.string()
            .min(1),

        image_url:
          z.string()
            .url()
      }
    },

    async ({
      video_id,
      image_url
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await setFacebookPreferredThumbnailFromUrl(
            env,
            pageToken,
            video_id,
            image_url
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
  // FACEBOOK — DELETE POST / VIDEO / REEL
  // ====================================================

  server.registerTool(
    "delete_facebook_content",

    {
      description:
        "FINAL DESTRUCTIVE ACTION. Delete one TBG Motors Facebook post, video or Reel by its exact Meta object ID. Only use after explicit user approval.",

      inputSchema: {
        object_id:
          z.string()
            .min(1)
      },

      annotations: {
        destructiveHint:
          true
      }
    },

    async ({
      object_id
    }) => {
      try {
        const pageToken =
          await getFacebookPageAccessToken(
            env
          );

        return result(
          await graphDelete(
            FACEBOOK_GRAPH,
            pageToken,
            object_id
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
  // INSTAGRAM — DELETE MEDIA
  // ====================================================

  server.registerTool(
    "delete_instagram_media",

    {
      description:
        "FINAL DESTRUCTIVE ACTION. Delete one Instagram post, carousel, Reel or Story by exact media ID. Requires the Meta instagram_manage_contents permission. Use api_mode=facebook_login for media created through Instagram API with Facebook Login. Only use after explicit user approval.",

      inputSchema: {
        media_id:
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
        destructiveHint:
          true
      }
    },

    async ({
      media_id,
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
            await graphDelete(
              FACEBOOK_GRAPH,
              token,
              media_id
            )
          );
        }

        return result(
          await graphDelete(
            INSTAGRAM_GRAPH,
            env.META_ACCESS_TOKEN,
            media_id
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
  // SCHEDULING — CREATE
  // ====================================================

  server.registerTool(
    "schedule_social_post",

    {
      description:
        "Schedule a future TBG Motors Instagram and/or Facebook publication. The job is persisted in a Cloudflare Durable Object and runs automatically at the requested ISO timestamp without reopening ChatGPT. Use photo for 1-10 images, reel for Reels, video for an ordinary Facebook video, or text for Facebook text-only. Final publication happens automatically at the scheduled time, so only schedule after explicit user approval.",

      inputSchema: {
        scheduled_at:
          z.string()
            .min(1),

        platforms:
          z.array(
            z.enum([
              "instagram",
              "facebook"
            ])
          )
          .min(1)
          .max(2),

        content_type:
          z.enum([
            "photo",
            "reel",
            "video",
            "text"
          ]),

        caption:
          z.string()
            .max(2200)
            .optional(),

        title:
          z.string()
            .max(500)
            .optional(),

        image_urls:
          z.array(
            z.string()
              .url()
          )
          .max(10)
          .optional(),

        video_url:
          z.string()
            .url()
            .optional(),

        cover_url:
          z.string()
            .url()
            .optional(),

        share_to_feed:
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
      scheduled_at,
      platforms,
      content_type,
      caption,
      title,
      image_urls,
      video_url,
      cover_url,
      share_to_feed,
      audio_configuration
    }) => {
      try {
        const when =
          new Date(
            scheduled_at
          );


        if (
          Number.isNaN(
            when.getTime()
          )
        ) {
          throw new Error(
            "scheduled_at must be a valid ISO date-time."
          );
        }


        if (
          when.getTime()
          <=
          Date.now()
        ) {
          throw new Error(
            "scheduled_at must be in the future."
          );
        }


        if (
          content_type
          ===
          "text"
          &&
          platforms.includes(
            "instagram"
          )
        ) {
          throw new Error(
            "Instagram does not support text-only scheduled posts."
          );
        }


        if (
          content_type
          ===
          "photo"
          &&
          (
            !image_urls
            ||
            image_urls.length
            <
            1
          )
        ) {
          throw new Error(
            "Photo scheduling requires at least one image URL."
          );
        }


        if (
          (
            content_type
            ===
            "reel"
            ||
            content_type
            ===
            "video"
          )
          &&
          !video_url
        ) {
          throw new Error(
            "Video/Reel scheduling requires video_url."
          );
        }


        return result(
          await schedulerRequest(
            env,
            "POST",
            "/jobs",
            {
              scheduled_at:
                when.toISOString(),

              content: {
                platforms,
                content_type,
                caption,
                title,
                image_urls,
                video_url,
                cover_url,
                share_to_feed,
                audio_configuration
              }
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
  // SCHEDULING — LIST
  // ====================================================

  server.registerTool(
    "list_scheduled_social_posts",

    {
      description:
        "List persisted TBG Motors scheduled social-media jobs and their current status. Read-only.",

      inputSchema: {
        status:
          z.enum([
            "all",
            "scheduled",
            "processing",
            "completed",
            "cancelled",
            "failed"
          ])
          .optional()
      },

      annotations: {
        readOnlyHint:
          true
      }
    },

    async ({
      status
    }) => {
      try {
        const query =
          status
          &&
          status
          !==
          "all"
            ?
            `?status=${encodeURIComponent(status)}`
            :
            "";


        return result(
          await schedulerRequest(
            env,
            "GET",
            `/jobs${query}`
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
  // SCHEDULING — MOVE
  // ====================================================

  server.registerTool(
    "move_scheduled_social_post",

    {
      description:
        "Move one not-yet-started TBG Motors scheduled social-media job to a new ISO date-time. Only use after explicit user approval.",

      inputSchema: {
        job_id:
          z.string()
            .min(1),

        scheduled_at:
          z.string()
            .min(1)
      }
    },

    async ({
      job_id,
      scheduled_at
    }) => {
      try {
        const when =
          new Date(
            scheduled_at
          );


        if (
          Number.isNaN(
            when.getTime()
          )
          ||
          when.getTime()
          <=
          Date.now()
        ) {
          throw new Error(
            "scheduled_at must be a valid future ISO date-time."
          );
        }


        return result(
          await schedulerRequest(
            env,
            "PATCH",
            `/jobs/${encodeURIComponent(job_id)}`,
            {
              scheduled_at:
                when.toISOString()
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
  // SCHEDULING — CANCEL
  // ====================================================

  server.registerTool(
    "cancel_scheduled_social_post",

    {
      description:
        "Cancel one not-yet-completed TBG Motors scheduled social-media job. Only use after explicit user approval.",

      inputSchema: {
        job_id:
          z.string()
            .min(1)
      },

      annotations: {
        destructiveHint:
          true
      }
    },

    async ({
      job_id
    }) => {
      try {
        return result(
          await schedulerRequest(
            env,
            "DELETE",
            `/jobs/${encodeURIComponent(job_id)}`
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
