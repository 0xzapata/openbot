/**
 * The YouTube adapter: Google OAuth for an installed app (PKCE), one resumable video upload through the
 * YouTube Data API v3, and a status read until YouTube has processed the video.
 *
 * `youtube.upload` alone cannot read the channel or the video status (`channels.list` and `videos.list`
 * need a read scope), so the sign-in asks for `youtube.readonly` too.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import {
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
import { decode, gaveUp, pendingExpired, processingPending } from "./meta-adapters";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const YOUTUBE_SCOPES =
  "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const NETWORK = "YouTube";
/** "People & Blogs", the category that the YouTube documents use in their examples. */
const CATEGORY_ID = "22";
const CHECK_AFTER_MS = 60_000;
/** A video is up to 1 GB, so its PUT can take long on a slow line. */
const VIDEO_UPLOAD_TIMEOUT_MS = 60 * 60_000;
/** Each of these is one more PUT, or one more status query of the session, after a server error or a lost line. */
const UPLOAD_ATTEMPTS = 3;
/** Reasons of a 403 or 400 that mean "later", not "never". */
const RATE_LIMIT_REASONS = new Set([
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "uploadLimitExceeded",
]);

const pendingSchema = z.object({ videoId: z.string(), startedAt: z.string() });

export class YouTubeAdapter implements ContentAdapter {
  readonly platform = "youtube" as const;
  readonly #options: ContentAdapterOptions;

  constructor(options: ContentAdapterOptions) {
    this.#options = options;
  }

  generateAuthUrl(input: { clientId: string; redirectUri: string }) {
    const { state, codeVerifier, codeChallenge } = oauthSecrets();
    const url = new URL(AUTHORIZE_URL);
    url.search = formBody({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: YOUTUBE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      // A refresh token comes only with offline access, and again only with a new consent.
      access_type: "offline",
      prompt: "consent",
    });
    return { url: url.toString(), state, codeVerifier };
  }

  readonly authenticate = Effect.fn("YouTubeAdapter.authenticate")(function* (
    this: YouTubeAdapter,
    input: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string },
  ) {
    const tokens = yield* this.#token({
      client_id: input.clientId,
      // A Desktop client's secret is not confidential, and a client without one sends none.
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    const response = yield* contentRequest(this.#options, NETWORK, CHANNELS_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* youTubeError(response, body);
    const channel = isDynamicRecord(body) && Array.isArray(body.items) ? body.items[0] : null;
    const snippet = isDynamicRecord(channel) && isDynamicRecord(channel.snippet) ? channel.snippet : null;
    if (!isDynamicRecord(channel) || typeof channel.id !== "string" || typeof snippet?.title !== "string")
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noProfile", { network: NETWORK }),
      });
    const handle = typeof snippet.customUrl === "string" && snippet.customUrl ? snippet.customUrl : snippet.title;
    return { tokens, profile: { externalAccountId: channel.id, handle, displayName: snippet.title } };
  });

  refreshToken(input: { clientId: string; clientSecret: string | null; refreshToken: string }) {
    return this.#token({
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    });
  }

  readonly #token = Effect.fn("YouTubeAdapter.token")(function* (this: YouTubeAdapter, grant: Record<string, string>) {
    const response = yield* contentRequest(this.#options, NETWORK, TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(grant),
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* youTubeError(response, body, true);
    return yield* tokensOf(body, this.#options.now(), NETWORK);
  });

  readonly publish = Effect.fn("YouTubeAdapter.publish")(function* (
    this: YouTubeAdapter,
    input: { accessToken: string; body: string; title: string | null; media: ContentPublishMedia | null },
  ) {
    const media = input.media;
    // `contentVariantIssues` already asks for a video and a title.
    if (media?.kind !== "video" || !input.title)
      return yield* new ContentAdapterError({
        code: "invalid",
        status: null,
        message: sourceText("error.content.issueNeedsVideo"),
      });
    const metadata = JSON.stringify({
      snippet: { title: input.title, description: input.body, categoryId: CATEGORY_ID },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });
    // ponytail: one PUT of the whole file; YouTube takes chunks of 256 KiB multiples when a file is too
    // large for one request. Add chunks if users post files above the 1 GB cap of the composer.
    let session: string | null = null;
    let from = 0;
    // `unknown`: the last answer did not say how much the session has, so YouTube may have the whole video.
    let unknown = false;
    let waitMs: number | null = null;
    const total = media.file.size;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
      let answer: SessionState;
      if (unknown && session !== null) {
        // 1 s, 2 s, ... or `Retry-After`. ponytail: the wait holds this publish, at most 2 waits of up to 60 s;
        // move it to the timer if the attempts grow.
        yield* Effect.promise(() => this.#options.sleep(waitMs ?? 1_000 * 2 ** (attempt - 1)));
        answer = yield* this.#sessionState(input.accessToken, session, total);
      } else {
        if (session === null) {
          session = yield* this.#startSession(input.accessToken, metadata, media);
          from = 0;
        }
        const put = yield* contentRequest(this.#options, NETWORK, session, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": media.mimeType,
            ...(from > 0 ? { "Content-Range": `bytes ${from}-${total - 1}/${total}` } : {}),
          },
          // A file-backed Blob: `fetch` reads the file as it sends it.
          body: from > 0 ? media.file.slice(from) : media.file,
          timeoutMs: VIDEO_UPLOAD_TIMEOUT_MS,
        }).pipe(Effect.result);
        if (put._tag === "Success" && put.success.status < 500) {
          const body = yield* responseJson(put.success);
          if (!put.success.ok) return yield* youTubeError(put.success, body);
          return yield* this.#uploaded(body);
        }
        // A server error or a lost line: ask the session how much it has.
        answer = yield* this.#sessionState(input.accessToken, session, total);
      }
      unknown = answer.kind === "unknown";
      waitMs = answer.kind === "unknown" ? answer.retryAfterMs : null;
      if (answer.kind === "done") return yield* this.#uploaded(answer.body);
      if (answer.kind === "restart") session = null;
      else if (answer.kind === "resume") from = answer.from;
    }
    if (unknown)
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: null,
        message: sourceText("error.content.noAnswer", { network: NETWORK }),
      });
    return yield* new ContentAdapterError({
      code: "server",
      status: null,
      message: sourceText("error.content.uploadIncomplete", { network: NETWORK }),
    });
  });

  readonly #startSession = Effect.fn("YouTubeAdapter.startSession")(function* (
    this: YouTubeAdapter,
    accessToken: string,
    metadata: string,
    media: Extract<ContentPublishMedia, { kind: "video" }>,
  ) {
    const response = yield* contentRequest(this.#options, NETWORK, UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(media.file.size),
        "X-Upload-Content-Type": media.mimeType,
      },
      body: metadata,
    });
    if (!response.ok) return yield* youTubeError(response, yield* responseJson(response));
    const location = response.headers.get("location");
    // The video and the Bearer token go to this address: only an https address of Google is taken.
    if (!location || !isGoogleApisUrl(location))
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noUploadAddress", { network: NETWORK }),
      });
    return location;
  });

  /**
   * The state of an upload session after a failed PUT (Google's resumable-upload guide). 308 with
   * `Range: bytes=0-N` resumes at N+1, and 308 with no `Range` at 0. A 404 or 410 session has ended and the
   * upload starts again. A lost line or a 5xx says nothing: ask again after a wait.
   */
  readonly #sessionState = Effect.fn("YouTubeAdapter.sessionState")(function* (
    this: YouTubeAdapter,
    accessToken: string,
    session: string,
    total: number,
  ): Effect.fn.Return<SessionState> {
    const response = yield* contentRequest(this.#options, NETWORK, session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Range": `bytes */${total}` },
    }).pipe(Effect.orElseSucceed(() => null));
    if (!response) return { kind: "unknown", retryAfterMs: null };
    if (response.status === 200 || response.status === 201)
      return { kind: "done", body: yield* responseJson(response) };
    if (response.status === 404 || response.status === 410) return { kind: "restart" };
    if (response.status === 308) {
      const range = /^bytes=0-(\d+)$/u.exec(response.headers.get("range") ?? "");
      return { kind: "resume", from: range ? Number(range[1]) + 1 : 0 };
    }
    // ponytail: `Retry-After` in seconds only, capped at 60 s; an HTTP date falls back to the backoff.
    const seconds = Number(response.headers.get("retry-after"));
    return {
      kind: "unknown",
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : null,
    };
  });

  readonly #uploaded = Effect.fn("YouTubeAdapter.uploaded")(function* (this: YouTubeAdapter, body: unknown) {
    const videoId = isDynamicRecord(body) ? body.id : null;
    if (typeof videoId !== "string" || !videoId)
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: null,
        message: sourceText("error.content.noPostId", { network: NETWORK }),
      });
    // YouTube has the video, and it is not playable until YouTube has processed it.
    return processingPending({ videoId, startedAt: this.#options.now().toISOString() }, CHECK_AFTER_MS);
  });

  readonly checkPostStatus = Effect.fn("YouTubeAdapter.checkPostStatus")(function* (
    this: YouTubeAdapter,
    input: { accessToken: string; pendingData: string },
  ) {
    const pending = decode(pendingSchema, input.pendingData);
    if (!pending)
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.uploadStateInvalid", { network: NETWORK }),
      });
    const url = new URL(VIDEOS_URL);
    url.search = formBody({ part: "status,processingDetails", id: pending.videoId });
    // YouTube has the video, so a status read that fails for a while does not fail the post: a retry would
    // upload a second copy. Read again until the 24 h cap.
    const later = () =>
      pendingExpired(pending.startedAt, this.#options.now())
        ? Effect.fail(gaveUp(NETWORK))
        : Effect.succeed(processingPending(pending, CHECK_AFTER_MS));
    const response = yield* contentRequest(this.#options, NETWORK, url.toString(), {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    }).pipe(Effect.orElseSucceed(() => null));
    if (!response) return yield* later();
    const body = yield* responseJson(response);
    if (!response.ok) {
      const reason = errorReason(body);
      if (
        response.status >= 500 ||
        response.status === 429 ||
        (response.status === 403 &&
          (reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"))
      )
        return yield* later();
      return yield* youTubeError(response, body);
    }
    const video = isDynamicRecord(body) && Array.isArray(body.items) ? body.items[0] : null;
    const status = isDynamicRecord(video) && isDynamicRecord(video.status) ? video.status : {};
    const processing =
      isDynamicRecord(video) && isDynamicRecord(video.processingDetails) ? video.processingDetails : {};
    const reason =
      shortProviderText(status.rejectionReason) ??
      shortProviderText(status.failureReason) ??
      shortProviderText(processing.processingFailureReason);
    if (
      status.uploadStatus === "failed" ||
      status.uploadStatus === "rejected" ||
      processing.processingStatus === "failed" ||
      processing.processingStatus === "terminated"
    )
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.refusedPost", {
          network: NETWORK,
          reason: reason ?? String(status.uploadStatus ?? processing.processingStatus),
        }),
      });
    if (processing.processingStatus === "succeeded") {
      const result: ContentPublishResult = {
        kind: "published",
        externalPostId: pending.videoId,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(pending.videoId)}`,
      };
      return result;
    }
    if (pendingExpired(pending.startedAt, this.#options.now())) return yield* gaveUp(NETWORK);
    return processingPending(pending, CHECK_AFTER_MS);
  });
}

type SessionState =
  | { kind: "done"; body: unknown }
  | { kind: "restart" }
  | { kind: "resume"; from: number }
  | { kind: "unknown"; retryAfterMs: number | null };

/** An https address on `googleapis.com` or one of its subdomains. */
function isGoogleApisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"));
  } catch {
    return false;
  }
}

/** The first `errors[].reason` of a Google error answer. */
function errorReason(body: unknown): string | null {
  const error = isDynamicRecord(body) && isDynamicRecord(body.error) ? body.error : {};
  const first = Array.isArray(error.errors) && isDynamicRecord(error.errors[0]) ? error.errors[0] : {};
  return typeof first.reason === "string" ? first.reason : null;
}

/** The typed error of a Google answer: `{ error: { code, message, errors: [{ reason }] } }`, or OAuth `{ error }`. */
function youTubeError(
  response: Response,
  body: unknown,
  tokenRequest = false,
): Effect.Effect<never, ContentAdapterError> {
  const status = response.status;
  const record = isDynamicRecord(body) ? body : {};
  const error = isDynamicRecord(record.error) ? record.error : {};
  const reason = errorReason(body);
  const text = shortProviderText(error.message) ?? shortProviderText(record.error_description);
  const fail = (code: ContentAdapterError["code"], message: string) =>
    Effect.fail(new ContentAdapterError({ code, status, message }));
  if (status === 401 || record.error === "invalid_grant" || (tokenRequest && status === 400))
    return fail("signed-out", sourceText("error.content.signInAgainYouTube"));
  // Google lists `uploadLimitExceeded` as 400 and the quota reasons as 403: take them on any 4xx.
  if (status === 429 || (status >= 400 && status < 500 && reason !== null && RATE_LIMIT_REASONS.has(reason)))
    return fail("rate-limited", sourceText("error.content.rateLimitedLater", { network: NETWORK }));
  if (status >= 500)
    return fail("server", sourceText("error.content.serverError", { network: NETWORK, status: String(status) }));
  return fail(
    "rejected",
    sourceText("error.content.refusedPost", { network: NETWORK, reason: text ?? `HTTP ${status}` }),
  );
}
