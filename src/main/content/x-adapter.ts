/**
 * The X adapter: OAuth 2 with PKCE, one image upload, and one post through the X API v2.
 * The text goes as it is; the composer already counts a link as 23.
 */

import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
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
  imageOnly,
  oauthSecrets,
  responseJson,
  shortProviderText,
  tokensOf,
} from "./content-adapter";
import { gaveUp, pendingExpired, processingPending } from "./meta-adapters";

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
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noProfile", { network: NETWORK }),
      });
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
    const media = yield* imageOnly(input.media);
    if (!media) return yield* this.#createPost(input.accessToken, input.body, null);
    const form = new FormData();
    form.append("media", new Blob([media.bytes], { type: media.mimeType }), media.name);
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
        message: sourceText("error.content.noMediaId", { network: NETWORK }),
      });
    // ponytail: a still image is usually ready at once; this branch matters for GIF and video. Keep it small.
    const pending = xPending(data, {
      mediaId: data.id,
      text: input.body,
      startedAt: this.#options.now().toISOString(),
    });
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
        message: sourceText("error.content.uploadStateInvalid", { network: NETWORK }),
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
        message: sourceText("error.content.imageFailed", { network: NETWORK }),
      });
    // Pending data from before `startedAt` starts its 24 h now.
    const startedAt = pending.startedAt ?? this.#options.now().toISOString();
    const again = xPending(data, { ...pending, startedAt });
    if (again && pendingExpired(startedAt, this.#options.now())) return yield* gaveUp(NETWORK);
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
        message: sourceText("error.content.noPostId", { network: NETWORK }),
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

/** The pending result of an upload that X still processes, or null when X has finished it. */
function xPending(data: DynamicRecord, pending: Required<XPending>): ContentPublishResult | null {
  const info = isDynamicRecord(data.processing_info) ? data.processing_info : null;
  if (info?.state !== "pending" && info?.state !== "in_progress") return null;
  const seconds = typeof info.check_after_secs === "number" && info.check_after_secs > 0 ? info.check_after_secs : 5;
  return processingPending(pending, seconds * 1000);
}

// `startedAt` is optional: pending data from before it has none.
const pendingSchema = z.object({ mediaId: z.string(), text: z.string(), startedAt: z.string().optional() });
type XPending = z.infer<typeof pendingSchema>;

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
    return Effect.fail(
      new ContentAdapterError({ code: "signed-out", status, message: sourceText("error.content.signInAgainX") }),
    );
  if (status === 429) {
    const reset = Number(response.headers.get("x-rate-limit-reset"));
    const message =
      Number.isFinite(reset) && reset > 0
        ? sourceText("error.content.rateLimitedUntil", { network: NETWORK, time: new Date(reset * 1000).toISOString() })
        : sourceText("error.content.rateLimited", { network: NETWORK });
    return Effect.fail(new ContentAdapterError({ code: "rate-limited", status, message }));
  }
  if (status >= 500)
    return Effect.fail(
      new ContentAdapterError({
        code: "server",
        status,
        message: sourceText("error.content.serverError", { network: NETWORK, status: String(status) }),
      }),
    );
  return Effect.fail(
    new ContentAdapterError({
      code: "rejected",
      status,
      message: sourceText("error.content.refusedPost", { network: NETWORK, reason: text ?? `HTTP ${status}` }),
    }),
  );
}
