/**
 * The Meta adapters: Instagram (Instagram API with Instagram Login, a professional account), Threads, and
 * one Facebook Page (Facebook Login).
 *
 * Instagram and Threads publish in two steps: a media container, which Meta builds from a public image
 * URL, and then the publish of the container. The container is `pending` (`processing`) until Meta has
 * built it. Instagram and Threads have no refresh token: the long-lived access token is stored as both
 * tokens, and a refresh renews it.
 *
 * The access token goes as the `access_token` parameter, as the Meta documents show: in the body of a POST,
 * in the query of a GET. An error text never holds a URL.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import {
  CONTENT_PENDING_LIMIT_MS,
  CONTENT_UPLOAD_TIMEOUT_MS,
  type ContentAdapter,
  ContentAdapterError,
  type ContentAdapterOptions,
  type ContentHostImage,
  type ContentPublishMedia,
  type ContentPublishResult,
  type ContentTokens,
  contentRequest,
  formBody,
  oauthSecrets,
  responseJson,
  shortProviderText,
  tokensOf,
} from "./content-adapter";

/**
 * The Graph API version of Instagram and Facebook. Meta keeps a version about 2 years; move to a newer
 * one before this one ends.
 */
export const META_GRAPH_VERSION = "v24.0";
export const THREADS_API_VERSION = "v1.0";

/** Instagram and Threads tokens last 60 days; a publish in the last week renews the token. */
const LONG_LIVED_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60_000;
const INSTAGRAM_IMAGE_BYTES = 8 * 1024 * 1024;

type MetaSignInKey =
  | "error.content.signInAgainInstagram"
  | "error.content.signInAgainThreads"
  | "error.content.signInAgainFacebook";

/** Graph codes of a rate limit. Code 9 is one only with subcode 2207042 (the Instagram publish limit). */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002]);

/**
 * The typed error of a Meta answer that is not 2xx: `{ error: { message, type, code, error_subcode,
 * is_transient } }`. `creates`: the request can make a post. Meta can answer a server or transient error
 * while the post goes live, so that answer is `unknown-result`.
 */
export function metaError(
  response: Response,
  body: unknown,
  network: string,
  signInKey: MetaSignInKey,
  tokenRequest = false,
  creates = false,
): Effect.Effect<never, ContentAdapterError> {
  const status = response.status;
  const error = isDynamicRecord(body) && isDynamicRecord(body.error) ? body.error : {};
  const code = typeof error.code === "number" ? error.code : null;
  const subcode = typeof error.error_subcode === "number" ? error.error_subcode : null;
  const text = shortProviderText(error.message) ?? shortProviderText(isDynamicRecord(body) ? body.error_message : null);
  const fail = (adapterCode: ContentAdapterError["code"], message: string) =>
    Effect.fail(new ContentAdapterError({ code: adapterCode, status, message }));
  if (code === 190 || status === 401) return fail("signed-out", sourceText(signInKey));
  if (status === 429 || (code !== null && META_RATE_LIMIT_CODES.has(code)) || (code === 9 && subcode === 2207042))
    return fail("rate-limited", sourceText("error.content.rateLimitedLater", { network }));
  if (status >= 500 || code === 1 || code === 2 || error.is_transient === true)
    return creates
      ? fail("unknown-result", sourceText("error.content.noAnswer", { network }))
      : fail("server", sourceText("error.content.serverError", { network, status: String(status) }));
  // A refused token request with no Graph code: the code or the token is no longer valid.
  if (tokenRequest && status === 400 && code === null) return fail("signed-out", sourceText(signInKey));
  if (code === 10 || (code !== null && code >= 200 && code <= 299))
    return fail(
      "rejected",
      sourceText("error.content.refusedPermission", { network, reason: text ?? `HTTP ${status}` }),
    );
  return fail("rejected", sourceText("error.content.refusedPost", { network, reason: text ?? `HTTP ${status}` }));
}

function invalid(message: string): ContentAdapterError {
  return new ContentAdapterError({ code: "invalid", status: null, message });
}

function needsSecret(network: string): ContentAdapterError {
  return new ContentAdapterError({
    code: "rejected",
    status: null,
    message: sourceText("error.content.needsSecret", { network }),
  });
}

/** The pending result of a network that still processes a post, with the time it started. */
export function processingPending(data: Record<string, string | number>, checkAfterMs: number): ContentPublishResult {
  return { kind: "pending", pendingData: JSON.stringify(data), checkAfterMs, reason: "processing" };
}

/** A post that a network still processes after 24 hours: OpenBot stops and the user checks the network. */
export function pendingExpired(startedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(startedAt) > CONTENT_PENDING_LIMIT_MS;
}

export function gaveUp(network: string): ContentAdapterError {
  return new ContentAdapterError({
    code: "unknown-result",
    status: null,
    message: sourceText("error.content.processingTimeout", { network }),
  });
}

/** The fixed values that make Instagram and Threads differ. */
interface ContainerNetwork {
  platform: "instagram" | "threads";
  name: string;
  authorizeUrl: string;
  scopes: string;
  shortTokenUrl: string;
  /** The Graph host, with no version: the long-lived token endpoints have none. */
  graph: string;
  version: string;
  exchangeGrant: string;
  refreshGrant: string;
  profileFields: string;
  mediaEdge: string;
  publishEdge: string;
  statusFields: string;
  statusField: string;
  errorField: string;
  checkAfterMs: number;
  signInKey: MetaSignInKey;
}

const INSTAGRAM: ContainerNetwork = {
  platform: "instagram",
  name: "Instagram",
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  scopes: "instagram_business_basic,instagram_business_content_publish",
  shortTokenUrl: "https://api.instagram.com/oauth/access_token",
  graph: "https://graph.instagram.com",
  version: META_GRAPH_VERSION,
  exchangeGrant: "ig_exchange_token",
  refreshGrant: "ig_refresh_token",
  profileFields: "user_id,username",
  mediaEdge: "media",
  publishEdge: "media_publish",
  statusFields: "status_code,status",
  statusField: "status_code",
  errorField: "status",
  // Meta: read the status about once a minute. Each IN_PROGRESS answer doubles the wait.
  checkAfterMs: 60_000,
  signInKey: "error.content.signInAgainInstagram",
};

const THREADS: ContainerNetwork = {
  platform: "threads",
  name: "Threads",
  authorizeUrl: "https://threads.com/oauth/authorize",
  scopes: "threads_basic,threads_content_publish",
  shortTokenUrl: "https://graph.threads.com/oauth/access_token",
  graph: "https://graph.threads.com",
  version: THREADS_API_VERSION,
  exchangeGrant: "th_exchange_token",
  refreshGrant: "th_refresh_token",
  profileFields: "id,username",
  mediaEdge: "threads",
  publishEdge: "threads_publish",
  statusFields: "status,error_message",
  statusField: "status",
  errorField: "error_message",
  // Meta: wait about 30 s before the publish.
  checkAfterMs: 30_000,
  signInKey: "error.content.signInAgainThreads",
};

/** The longest wait between two status reads of a container. */
const CONTAINER_MAX_CHECK_AFTER_MS = 15 * 60_000;

// `intervalMs` is optional: pending data from before it has none.
const containerPendingSchema = z.object({
  containerId: z.string(),
  userId: z.string(),
  startedAt: z.string(),
  intervalMs: z.number().optional(),
});

/** Instagram and Threads: a container from a public image URL or from text, then its publish. */
class ContainerAdapter implements ContentAdapter {
  readonly platform: "instagram" | "threads";
  readonly refreshMarginMs = LONG_LIVED_REFRESH_MARGIN_MS;
  readonly #options: ContentAdapterOptions;
  readonly #network: ContainerNetwork;

  constructor(options: ContentAdapterOptions, network: ContainerNetwork) {
    this.#options = options;
    this.#network = network;
    this.platform = network.platform;
  }

  #url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.#network.graph}/${this.#network.version}/${path}`);
    url.search = formBody(query);
    return url.toString();
  }

  generateAuthUrl(input: { clientId: string; redirectUri: string }) {
    const { state, codeVerifier, codeChallenge } = oauthSecrets();
    const url = new URL(this.#network.authorizeUrl);
    // PKCE is not in the Meta documents for these two; it goes anyway, as for LinkedIn.
    url.search = formBody({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: this.#network.scopes,
      response_type: "code",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), state, codeVerifier };
  }

  readonly authenticate = Effect.fn("ContainerAdapter.authenticate")(function* (
    this: ContainerAdapter,
    input: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string },
  ) {
    const network = this.#network;
    if (!input.clientSecret) return yield* needsSecret(network.name);
    const short = yield* contentRequest(this.#options, network.name, network.shortTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
        // Instagram adds `#_` to the code in the redirect.
        code: input.code.replace(/#_$/u, ""),
        code_verifier: input.codeVerifier,
      }),
    });
    const shortBody = yield* responseJson(short);
    if (!short.ok) return yield* metaError(short, shortBody, network.name, network.signInKey, true);
    // The Instagram documents show the token both flat and in `data[0]`.
    const shortToken = isDynamicRecord(shortBody) && Array.isArray(shortBody.data) ? shortBody.data[0] : shortBody;
    const first = yield* tokensOf(shortToken, this.#options.now(), network.name);
    registerSecretValue(first.accessToken);
    const longUrl = new URL(`${network.graph}/access_token`);
    longUrl.search = formBody({
      grant_type: network.exchangeGrant,
      client_secret: input.clientSecret,
      access_token: first.accessToken,
    });
    const tokens = yield* this.#longLived(longUrl.toString(), first.scopes);
    const response = yield* contentRequest(
      this.#options,
      network.name,
      this.#url("me", { fields: network.profileFields, access_token: tokens.accessToken }),
      {},
    );
    const body = yield* responseJson(response);
    if (!response.ok) return yield* metaError(response, body, network.name, network.signInKey);
    const record = isDynamicRecord(body) ? body : {};
    // Instagram: `user_id` is the professional account id that publishes; `id` is app-scoped.
    const id = record.user_id ?? record.id;
    const userId = typeof id === "number" ? String(id) : id;
    if (typeof userId !== "string" || !userId || typeof record.username !== "string")
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noProfile", { network: network.name }),
      });
    return { tokens, profile: { externalAccountId: userId, handle: record.username, displayName: null } };
  });

  /** Renews the long-lived token. It must be at least 24 hours old and not ended. */
  refreshToken(input: { clientId: string; clientSecret: string | null; refreshToken: string }) {
    const url = new URL(`${this.#network.graph}/refresh_access_token`);
    url.search = formBody({ grant_type: this.#network.refreshGrant, access_token: input.refreshToken });
    return this.#longLived(url.toString(), "");
  }

  /** A long-lived token answer. The token is stored as the refresh token too: a refresh renews it. */
  readonly #longLived = Effect.fn("ContainerAdapter.longLived")(function* (
    this: ContainerAdapter,
    url: string,
    scopes: string,
  ) {
    const response = yield* contentRequest(this.#options, this.#network.name, url, {});
    const body = yield* responseJson(response);
    if (!response.ok) return yield* metaError(response, body, this.#network.name, this.#network.signInKey, true);
    const tokens = yield* tokensOf(body, this.#options.now(), this.#network.name);
    const result: ContentTokens = { ...tokens, refreshToken: tokens.accessToken, scopes: tokens.scopes || scopes };
    return result;
  });

  readonly publish = Effect.fn("ContainerAdapter.publish")(function* (
    this: ContainerAdapter,
    input: {
      accessToken: string;
      profile: { externalAccountId: string };
      body: string;
      title?: string | null;
      media: ContentPublishMedia | null;
      hostImage?: ContentHostImage;
    },
  ) {
    const network = this.#network;
    const userId = input.profile.externalAccountId;
    const fields: Record<string, string> = { access_token: input.accessToken };
    if (network.platform === "instagram") {
      // `contentVariantIssues` already asks for an image. Meta takes JPEG only, up to 8 MB.
      // ponytail: no conversion of PNG, WEBP or GIF in v1; convert to JPEG here when users ask.
      if (!input.media) return yield* invalid(sourceText("error.content.issueNeedsImage"));
      if (input.media.mimeType !== "image/jpeg" || input.media.bytes.byteLength > INSTAGRAM_IMAGE_BYTES)
        return yield* invalid(sourceText("error.content.instagramJpegOnly"));
      if (!input.hostImage) return yield* invalid(sourceText("error.content.instagramNeedsHost"));
      fields.image_url = (yield* input.hostImage(input.media)).url;
      fields.caption = input.body;
    } else if (input.media) {
      if (!input.hostImage) return yield* invalid(sourceText("error.content.threadsNeedsHost"));
      fields.image_url = (yield* input.hostImage(input.media)).url;
      fields.media_type = "IMAGE";
      fields.text = input.body;
    } else {
      fields.media_type = "TEXT";
      fields.text = input.body;
    }
    const response = yield* contentRequest(
      this.#options,
      network.name,
      this.#url(`${encodeURIComponent(userId)}/${network.mediaEdge}`),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody(fields),
        timeoutMs: CONTENT_UPLOAD_TIMEOUT_MS,
      },
    );
    const body = yield* responseJson(response);
    if (!response.ok) return yield* metaError(response, body, network.name, network.signInKey);
    const containerId = isDynamicRecord(body) ? body.id : null;
    if (typeof containerId !== "string" || !containerId)
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noMediaId", { network: network.name }),
      });
    return processingPending(
      { containerId, userId, startedAt: this.#options.now().toISOString() },
      network.checkAfterMs,
    );
  });

  readonly checkPostStatus = Effect.fn("ContainerAdapter.checkPostStatus")(function* (
    this: ContainerAdapter,
    input: { accessToken: string; pendingData: string },
  ) {
    const network = this.#network;
    const pending = decode(containerPendingSchema, input.pendingData);
    if (!pending)
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.uploadStateInvalid", { network: network.name }),
      });
    const record = yield* this.#containerStatus(input.accessToken, pending.containerId);
    switch (record[network.statusField]) {
      case "FINISHED":
        return yield* this.#publishContainer(input.accessToken, pending.userId, pending.containerId);
      case "ERROR":
        return yield* new ContentAdapterError({
          code: "rejected",
          status: null,
          message: sourceText("error.content.refusedPost", {
            network: network.name,
            reason: shortProviderText(record[network.errorField]) ?? "ERROR",
          }),
        });
      case "EXPIRED":
        return yield* gaveUp(network.name);
      // A publish that ended before its answer came: the post is live, but its id is not known.
      case "PUBLISHED":
        return yield* new ContentAdapterError({
          code: "unknown-result",
          status: null,
          message: sourceText("error.content.noPostId", { network: network.name }),
        });
    }
    if (pendingExpired(pending.startedAt, this.#options.now())) return yield* gaveUp(network.name);
    const intervalMs = Math.min((pending.intervalMs ?? network.checkAfterMs) * 2, CONTAINER_MAX_CHECK_AFTER_MS);
    return processingPending({ ...pending, intervalMs }, intervalMs);
  });

  /** The status answer of a container. */
  readonly #containerStatus = Effect.fn("ContainerAdapter.containerStatus")(function* (
    this: ContainerAdapter,
    accessToken: string,
    containerId: string,
  ) {
    const network = this.#network;
    const response = yield* contentRequest(
      this.#options,
      network.name,
      this.#url(encodeURIComponent(containerId), { fields: network.statusFields, access_token: accessToken }),
      {},
    );
    const body = yield* responseJson(response);
    if (!response.ok) return yield* metaError(response, body, network.name, network.signInKey);
    return isDynamicRecord(body) ? body : {};
  });

  readonly #publishContainer = Effect.fn("ContainerAdapter.publishContainer")(function* (
    this: ContainerAdapter,
    accessToken: string,
    userId: string,
    containerId: string,
  ) {
    const network = this.#network;
    const response = yield* contentRequest(
      this.#options,
      network.name,
      this.#url(`${encodeURIComponent(userId)}/${network.publishEdge}`),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody({ creation_id: containerId, access_token: accessToken }),
        creates: true,
      },
    );
    const body = yield* responseJson(response);
    if (!response.ok) {
      const error = yield* Effect.flip(metaError(response, body, network.name, network.signInKey, false, true));
      if (error.code !== "unknown-result") return yield* error;
      // The container tells if the post went live: FINISHED is not published, so the error stays a server error.
      const state = yield* this.#containerStatus(accessToken, containerId).pipe(
        Effect.map((record) => record[network.statusField]),
        Effect.orElseSucceed(() => null),
      );
      if (state === "FINISHED") return yield* metaError(response, body, network.name, network.signInKey);
      return yield* error;
    }
    const mediaId = isDynamicRecord(body) ? body.id : null;
    if (typeof mediaId !== "string" || !mediaId)
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: response.status,
        message: sourceText("error.content.noPostId", { network: network.name }),
      });
    // Best effort: the post is live, so a failed read of its address does not fail it.
    const link = yield* contentRequest(
      this.#options,
      network.name,
      this.#url(encodeURIComponent(mediaId), { fields: "permalink", access_token: accessToken }),
      {},
    ).pipe(
      Effect.flatMap((answer) => (answer.ok ? responseJson(answer) : Effect.succeed(null))),
      Effect.orElseSucceed(() => null),
    );
    const permalink = isDynamicRecord(link) && typeof link.permalink === "string" ? link.permalink : null;
    const result: ContentPublishResult = { kind: "published", externalPostId: mediaId, url: permalink };
    return result;
  });
}

export class InstagramAdapter extends ContainerAdapter {
  constructor(options: ContentAdapterOptions) {
    super(options, INSTAGRAM);
  }
}

export class ThreadsAdapter extends ContainerAdapter {
  constructor(options: ContentAdapterOptions) {
    super(options, THREADS);
  }
}

const FACEBOOK = "Facebook";
const FACEBOOK_GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const FACEBOOK_SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts";

/**
 * One Facebook Page. v1 connects only when the user manages exactly one Page, and stores that Page as the
 * account with its Page token. A Page token from a long-lived user token has no end date (not confirmed):
 * there is no refresh, and error 190 signs the account out.
 */
export class FacebookPageAdapter implements ContentAdapter {
  readonly platform = "facebook_page" as const;
  readonly #options: ContentAdapterOptions;

  constructor(options: ContentAdapterOptions) {
    this.#options = options;
  }

  generateAuthUrl(input: { clientId: string; redirectUri: string }) {
    const { state, codeVerifier, codeChallenge } = oauthSecrets();
    const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    url.search = formBody({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state,
      response_type: "code",
      scope: FACEBOOK_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), state, codeVerifier };
  }

  readonly #get = Effect.fn("FacebookPageAdapter.get")(function* (
    this: FacebookPageAdapter,
    path: string,
    query: Record<string, string>,
    tokenRequest = false,
  ) {
    const url = new URL(`${FACEBOOK_GRAPH}/${path}`);
    url.search = formBody(query);
    const response = yield* contentRequest(this.#options, FACEBOOK, url.toString(), {});
    const body = yield* responseJson(response);
    if (!response.ok)
      return yield* metaError(response, body, FACEBOOK, "error.content.signInAgainFacebook", tokenRequest);
    return body;
  });

  readonly authenticate = Effect.fn("FacebookPageAdapter.authenticate")(function* (
    this: FacebookPageAdapter,
    input: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string },
  ) {
    if (!input.clientSecret) return yield* needsSecret(FACEBOOK);
    const now = this.#options.now();
    const short = yield* tokensOf(
      yield* this.#get(
        "oauth/access_token",
        {
          client_id: input.clientId,
          redirect_uri: input.redirectUri,
          client_secret: input.clientSecret,
          code: input.code,
          code_verifier: input.codeVerifier,
        },
        true,
      ),
      now,
      FACEBOOK,
    );
    registerSecretValue(short.accessToken);
    const user = yield* tokensOf(
      yield* this.#get(
        "oauth/access_token",
        {
          grant_type: "fb_exchange_token",
          client_id: input.clientId,
          client_secret: input.clientSecret,
          fb_exchange_token: short.accessToken,
        },
        true,
      ),
      now,
      FACEBOOK,
    );
    registerSecretValue(user.accessToken);
    const pages = yield* this.#get("me/accounts", { fields: "id,name,access_token", access_token: user.accessToken });
    const list = isDynamicRecord(pages) && Array.isArray(pages.data) ? pages.data.filter(isDynamicRecord) : [];
    if (list.length === 0) return yield* invalid(sourceText("error.content.facebookNoPage"));
    if (list.length > 1) return yield* invalid(sourceText("error.content.facebookManyPages"));
    const page = list[0];
    if (
      !page ||
      typeof page.id !== "string" ||
      typeof page.name !== "string" ||
      typeof page.access_token !== "string" ||
      !page.access_token
    )
      return yield* new ContentAdapterError({
        code: "server",
        status: null,
        message: sourceText("error.content.noProfile", { network: FACEBOOK }),
      });
    const tokens: ContentTokens = {
      accessToken: page.access_token,
      refreshToken: null,
      expiresAt: null,
      scopes: user.scopes || short.scopes,
    };
    return { tokens, profile: { externalAccountId: page.id, handle: page.name, displayName: page.name } };
  });

  /** The Page token has no refresh: the user signs in again. */
  refreshToken(): Effect.Effect<ContentTokens, ContentAdapterError> {
    return Effect.fail(
      new ContentAdapterError({
        code: "signed-out",
        status: null,
        message: sourceText("error.content.signInAgainFacebook"),
      }),
    );
  }

  readonly publish = Effect.fn("FacebookPageAdapter.publish")(function* (
    this: FacebookPageAdapter,
    input: {
      accessToken: string;
      profile: { externalAccountId: string };
      body: string;
      title?: string | null;
      media: ContentPublishMedia | null;
    },
  ) {
    const pageId = encodeURIComponent(input.profile.externalAccountId);
    let request: { url: string; body: string | FormData; headers: Record<string, string> };
    if (input.media) {
      const form = new FormData();
      form.append("source", new Blob([input.media.bytes], { type: input.media.mimeType }), input.media.name);
      form.append("message", input.body);
      form.append("published", "true");
      form.append("access_token", input.accessToken);
      request = { url: `${FACEBOOK_GRAPH}/${pageId}/photos`, body: form, headers: {} };
    } else
      request = {
        url: `${FACEBOOK_GRAPH}/${pageId}/feed`,
        body: formBody({ message: input.body, access_token: input.accessToken }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      };
    const response = yield* contentRequest(this.#options, FACEBOOK, request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      creates: true,
      timeoutMs: CONTENT_UPLOAD_TIMEOUT_MS,
    });
    const body = yield* responseJson(response);
    if (!response.ok)
      return yield* metaError(response, body, FACEBOOK, "error.content.signInAgainFacebook", false, true);
    const record = isDynamicRecord(body) ? body : {};
    const postId = typeof record.post_id === "string" ? record.post_id : record.id;
    if (typeof postId !== "string" || !postId)
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: response.status,
        message: sourceText("error.content.noPostId", { network: FACEBOOK }),
      });
    const result: ContentPublishResult = {
      kind: "published",
      externalPostId: postId,
      url: `https://www.facebook.com/${postId}`,
    };
    return result;
  });

  /** A Page post is live at once: nothing waits. */
  checkPostStatus(): Effect.Effect<ContentPublishResult, ContentAdapterError> {
    return Effect.fail(
      new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.uploadStateInvalid", { network: FACEBOOK }),
      }),
    );
  }
}

/** The pending data of an adapter, or null when it is not valid. */
export function decode<T>(schema: z.ZodType<T>, value: string): T | null {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
