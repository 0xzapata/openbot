/**
 * The interface of one social network for the content manager: the browser sign-in (OAuth 2 with PKCE),
 * the token refresh and the publish of one post. Each adapter gets `fetch` and a clock from its owner, so
 * an E2E check runs it against a fake network.
 *
 * An error message never holds a token, a code, a verifier, an Authorization header or a request body:
 * it can go to the log and to the variant row that the user reads.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ContentPendingReason, ContentPlatform } from "@openbot/contracts/ipc-content";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect, Schema } from "effect";

export interface ContentOAuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export interface ContentTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string;
}

export interface ContentProfile {
  externalAccountId: string;
  handle: string;
  displayName: string | null;
}

export type ContentPublishResult =
  | { kind: "published"; externalPostId: string; url: string | null }
  /**
   * The network still works on the post. `checkPostStatus` asks again after `checkAfterMs`. `reason`
   * `processing`: the network accepted the post, and it is not live yet.
   */
  | { kind: "pending"; pendingData: string; checkAfterMs: number; reason?: ContentPendingReason };

/** An image is read into memory: R2 hashes its bytes. A video stays a file-backed Blob that is read as it is sent. */
export type ContentPublishMedia =
  | { kind: "image"; mimeType: string; name: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "video"; mimeType: string; name: string; file: Blob };

export type ContentPublishImage = Extract<ContentPublishMedia, { kind: "image" }>;

/** The media of a network that takes images only. `contentVariantIssues` already refuses a video there. */
export function imageOnly(
  media: ContentPublishMedia | null,
): Effect.Effect<ContentPublishImage | null, ContentAdapterError> {
  if (media?.kind === "video")
    return Effect.fail(
      new ContentAdapterError({ code: "invalid", status: null, message: sourceText("error.content.issueImagesOnly") }),
    );
  return Effect.succeed(media);
}

export const CONTENT_ADAPTER_ERROR_CODES = [
  "signed-out",
  "rate-limited",
  "rejected",
  "network",
  "server",
  "unknown-result",
  "not-supported",
  // The post or its file does not fit the network. Nothing was sent.
  "invalid",
] as const;

export class ContentAdapterError extends Schema.TaggedError<ContentAdapterError>()("ContentAdapterError", {
  code: Schema.Literals(CONTENT_ADAPTER_ERROR_CODES),
  status: Schema.NullOr(Schema.Number),
  message: Schema.String,
}) {}

/** Puts the image of one publish on the image host, and gives its public URL. */
export type ContentHostImage = (media: ContentPublishImage) => Effect.Effect<{ url: string }, ContentAdapterError>;

export interface ContentAdapter {
  readonly platform: ContentPlatform;
  /** A token that ends in less than this is refreshed before a publish. Default `CONTENT_REFRESH_MARGIN_MS`. */
  readonly refreshMarginMs?: number;
  /** Makes the `state` and the PKCE S256 verifier and challenge. */
  generateAuthUrl(input: { clientId: string; redirectUri: string }): ContentOAuthStart;
  authenticate(input: {
    clientId: string;
    clientSecret: string | null;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Effect.Effect<{ tokens: ContentTokens; profile: ContentProfile }, ContentAdapterError>;
  refreshToken(input: {
    clientId: string;
    clientSecret: string | null;
    refreshToken: string;
  }): Effect.Effect<ContentTokens, ContentAdapterError>;
  publish(input: {
    accessToken: string;
    profile: Pick<ContentProfile, "externalAccountId">;
    body: string;
    title: string | null;
    media: ContentPublishMedia | null;
    /** Only for a network that fetches the image from a public URL, and only when a host is set up. */
    hostImage?: ContentHostImage;
  }): Effect.Effect<ContentPublishResult, ContentAdapterError>;
  checkPostStatus(input: {
    accessToken: string;
    pendingData: string;
  }): Effect.Effect<ContentPublishResult, ContentAdapterError>;
}

/** The one form of `fetch` that the adapters use. The global `fetch` fits it. */
export type ContentFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ContentAdapterOptions {
  fetch: ContentFetch;
  now: () => Date;
  /** Waits between status reads. The E2E gives one that does not wait. */
  sleep: (ms: number) => Promise<void>;
}

export const CONTENT_REQUEST_TIMEOUT_MS = 30_000;
/** A network that still processes a post after this time has failed: Meta containers expire after 24 h. */
export const CONTENT_PENDING_LIMIT_MS = 24 * 60 * 60_000;
export const CONTENT_UPLOAD_TIMEOUT_MS = 120_000;

/** A random `state` and a PKCE S256 pair (RFC 7636). */
export function oauthSecrets(): { state: string; codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(48).toString("base64url");
  return {
    state: randomBytes(24).toString("base64url"),
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/**
 * One HTTP request. A throw or a timeout becomes `network`, or `unknown-result` for a request that can
 * make a post (`creates`): the network may have the post, so nothing sends it again by itself. An
 * interrupted request is aborted at once.
 */
export function contentRequest(
  options: Pick<ContentAdapterOptions, "fetch">,
  network: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; creates?: boolean },
): Effect.Effect<Response, ContentAdapterError> {
  const { timeoutMs = CONTENT_REQUEST_TIMEOUT_MS, creates = false, ...request } = init;
  return Effect.tryPromise({
    try: (interrupted) =>
      options.fetch(url, { ...request, signal: AbortSignal.any([interrupted, AbortSignal.timeout(timeoutMs)]) }),
    catch: () =>
      creates
        ? new ContentAdapterError({
            code: "unknown-result",
            status: null,
            message: sourceText("error.content.noAnswer", { network }),
          })
        : new ContentAdapterError({
            code: "network",
            status: null,
            message: sourceText("error.content.unreachable", { network }),
          }),
  });
}

/** The JSON body of an answer, or null when it is not JSON. */
export function responseJson(response: Response): Effect.Effect<unknown> {
  return Effect.promise(() => response.json().catch(() => null));
}

/**
 * Provider text is short, has no line breaks, and is redacted: a network can repeat a token of the
 * request in its error, and this text goes to the log and to the variant row.
 */
export function shortProviderText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return redactText(value.replace(/\s+/gu, " ").trim().slice(0, 300));
}

export function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

/** The tokens of an OAuth token answer. A refresh token in the answer replaces the old one. */
export function tokensOf(body: unknown, now: Date, network: string): Effect.Effect<ContentTokens, ContentAdapterError> {
  if (!isDynamicRecord(body) || typeof body.access_token !== "string" || !body.access_token)
    return Effect.fail(
      new ContentAdapterError({
        code: "server",
        status: null,
        message: sourceText("error.content.noToken", { network }),
      }),
    );
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return Effect.succeed({
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(now.getTime() + expiresIn * 1000).toISOString(),
    scopes: typeof body.scope === "string" ? body.scope : "",
  });
}
