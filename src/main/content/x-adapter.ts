/**
 * The X adapter: OAuth 2 with PKCE, one image upload, and one post through the X API v2.
 * The text goes as it is; the composer already counts a link as 23.
 */

import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { z } from "zod";
import {
  CONTENT_UPLOAD_TIMEOUT_MS,
  type ContentAdapter,
  ContentAdapterError,
  type ContentAdapterOptions,
  type ContentPublishMedia,
  type ContentPublishResult,
  contentRequest,
  formBody,
  oauthSecrets,
  responseJson,
  shortProviderText,
  tokensOf,
} from "./content-adapter";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const ME_URL = "https://api.x.com/2/users/me";
const MEDIA_URL = "https://api.x.com/2/media/upload";
const TWEETS_URL = "https://api.x.com/2/tweets";
export const X_SCOPES = "tweet.read tweet.write users.read media.write offline.access";
const NETWORK = "X";

export class XAdapter implements ContentAdapter {
  readonly platform = "x" as const;
  readonly #options: ContentAdapterOptions;

  constructor(options: ContentAdapterOptions) {
    this.#options = options;
  }

  generateAuthUrl(input: { clientId: string; redirectUri: string }) {
    const { state, codeVerifier, codeChallenge } = oauthSecrets();
    const url = new URL(AUTHORIZE_URL);
    url.search = formBody({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: X_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), state, codeVerifier };
  }

  readonly authenticate = Effect.fn("XAdapter.authenticate")(function* (
    this: XAdapter,
    input: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string },
  ) {
    const tokens = yield* this.#token(input.clientId, input.clientSecret, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const response = yield* contentRequest(this.#options, NETWORK, ME_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* xError(response, body);
    const data = isDynamicRecord(body) && isDynamicRecord(body.data) ? body.data : null;
    if (typeof data?.id !== "string" || typeof data.username !== "string")
      return yield* new ContentAdapterError({ code: "server", status: response.status, message: "X sent no profile." });
    return {
      tokens,
      profile: {
        externalAccountId: data.id,
        handle: data.username,
        displayName: typeof data.name === "string" ? data.name : null,
      },
    };
  });

  refreshToken(input: { clientId: string; clientSecret: string | null; refreshToken: string }) {
    return this.#token(input.clientId, input.clientSecret, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
  }

  readonly publish = Effect.fn("XAdapter.publish")(function* (
    this: XAdapter,
    input: {
      accessToken: string;
      body: string;
      media: ContentPublishMedia | null;
    },
  ) {
    if (!input.media) return yield* this.#createPost(input.accessToken, input.body, null);
    const form = new FormData();
    form.append("media", new Blob([input.media.bytes], { type: input.media.mimeType }), input.media.name);
    form.append("media_category", "tweet_image");
    const response = yield* contentRequest(this.#options, NETWORK, MEDIA_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      body: form,
      timeoutMs: CONTENT_UPLOAD_TIMEOUT_MS,
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* xError(response, body);
    const data = isDynamicRecord(body) && isDynamicRecord(body.data) ? body.data : null;
    if (typeof data?.id !== "string")
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: "X sent no media id.",
      });
    // ponytail: a still image is usually ready at once; this branch matters for GIF and video. Keep it small.
    const pending = processingPending(data, data.id, input.body);
    if (pending) return pending;
    return yield* this.#createPost(input.accessToken, input.body, data.id);
  });

  readonly checkPostStatus = Effect.fn("XAdapter.checkPostStatus")(function* (
    this: XAdapter,
    input: { accessToken: string; pendingData: string },
  ) {
    const pending = decodePending(input.pendingData);
    if (!pending)
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: "The X upload state is not valid.",
      });
    const url = new URL(MEDIA_URL);
    url.search = formBody({ command: "STATUS", media_id: pending.mediaId });
    const response = yield* contentRequest(this.#options, NETWORK, url.toString(), {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* xError(response, body);
    const data = isDynamicRecord(body) && isDynamicRecord(body.data) ? body.data : {};
    const info = isDynamicRecord(data.processing_info) ? data.processing_info : null;
    if (info?.state === "failed")
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: "X could not process the image.",
      });
    const again = processingPending(data, pending.mediaId, pending.text);
    if (again) return again;
    return yield* this.#createPost(input.accessToken, pending.text, pending.mediaId);
  });

  readonly #createPost = Effect.fn("XAdapter.createPost")(function* (
    this: XAdapter,
    accessToken: string,
    text: string,
    mediaId: string | null,
  ) {
    const response = yield* contentRequest(this.#options, NETWORK, TWEETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(mediaId ? { text, media: { media_ids: [mediaId] } } : { text }),
      creates: true,
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* xError(response, body);
    const data = isDynamicRecord(body) && isDynamicRecord(body.data) ? body.data : null;
    if (typeof data?.id !== "string")
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: response.status,
        message: "X sent no post id. Check X before you retry.",
      });
    const result: ContentPublishResult = {
      kind: "published",
      externalPostId: data.id,
      url: `https://x.com/i/web/status/${data.id}`,
    };
    return result;
  });

  /** A public client sends `client_id` in the body; a client with a secret uses Basic and no `client_id`. */
  readonly #token = Effect.fn("XAdapter.token")(function* (
    this: XAdapter,
    clientId: string,
    clientSecret: string | null,
    grant: Record<string, string>,
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    const response = yield* contentRequest(this.#options, NETWORK, TOKEN_URL, {
      method: "POST",
      headers,
      body: formBody(clientSecret ? grant : { ...grant, client_id: clientId }),
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* xError(response, body, true);
    return yield* tokensOf(body, this.#options.now(), NETWORK);
  });
}

function processingPending(data: DynamicRecord, mediaId: string, text: string): ContentPublishResult | null {
  const info = isDynamicRecord(data.processing_info) ? data.processing_info : null;
  if (info?.state !== "pending" && info?.state !== "in_progress") return null;
  const seconds = typeof info.check_after_secs === "number" && info.check_after_secs > 0 ? info.check_after_secs : 5;
  return { kind: "pending", pendingData: JSON.stringify({ mediaId, text }), checkAfterMs: seconds * 1000 };
}

const pendingSchema = z.object({ mediaId: z.string(), text: z.string() });

/** The data of an upload that X still processes, or null when it is not valid. */
function decodePending(value: string): z.infer<typeof pendingSchema> | null {
  try {
    return pendingSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The typed error of an X answer that is not 2xx. A refused token request means the sign-in ended. */
function xError(response: Response, body: unknown, tokenRequest = false): Effect.Effect<never, ContentAdapterError> {
  const status = response.status;
  const record = isDynamicRecord(body) ? body : {};
  const first = Array.isArray(record.errors) && isDynamicRecord(record.errors[0]) ? record.errors[0] : {};
  const text =
    shortProviderText(record.detail) ??
    shortProviderText(record.title) ??
    shortProviderText(first.message) ??
    shortProviderText(record.error_description);
  if (status === 401 || (tokenRequest && (status === 400 || status === 403)))
    return Effect.fail(new ContentAdapterError({ code: "signed-out", status, message: "Sign in to X again." }));
  if (status === 429) {
    const reset = Number(response.headers.get("x-rate-limit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` Try again after ${new Date(reset * 1000).toISOString()}.` : "";
    return Effect.fail(
      new ContentAdapterError({ code: "rate-limited", status, message: `X limits the posts now.${when}` }),
    );
  }
  if (status >= 500)
    return Effect.fail(
      new ContentAdapterError({ code: "server", status, message: `X had a server error (${status}).` }),
    );
  return Effect.fail(
    new ContentAdapterError({ code: "rejected", status, message: `X refused the post: ${text ?? `HTTP ${status}`}` }),
  );
}
