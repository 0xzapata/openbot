/**
 * The LinkedIn adapter for a member profile (not a company page): OpenID sign-in with
 * `w_member_social`, one image through the Images API, and one post through the Posts API.
 * An ordinary LinkedIn app gets no refresh token: the user signs in again after about 60 days.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
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
  oauthSecrets,
  responseJson,
  shortProviderText,
  tokensOf,
} from "./content-adapter";
import { gaveUp, pendingExpired, processingPending } from "./meta-adapters";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const IMAGES_URL = "https://api.linkedin.com/rest/images";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
export const LINKEDIN_SCOPES = "openid profile w_member_social";
const NETWORK = "LinkedIn";

/**
 * The `LinkedIn-Version` header. LinkedIn makes a new version each month and keeps each one about one
 * year. An expired version answers 426: move this to a newer month then.
 */
export const LINKEDIN_API_VERSION = "202610";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
/** Status reads inside one publish, about 1 s apart. Then the variant waits as `pending`. */
const IMAGE_POLLS = 3;
const IMAGE_POLL_MS = 1_000;
const IMAGE_CHECK_AFTER_MS = 10_000;

/** LinkedIn "little text format": a backslash in front of each reserved character, the backslash first. */
export function escapeLinkedInCommentary(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/gu, (character) => `\\${character}`);
}

export class LinkedInAdapter implements ContentAdapter {
  readonly platform = "linkedin" as const;
  readonly #options: ContentAdapterOptions;

  constructor(options: ContentAdapterOptions) {
    this.#options = options;
  }

  generateAuthUrl(input: { clientId: string; redirectUri: string }) {
    const { state, codeVerifier, codeChallenge } = oauthSecrets();
    const url = new URL(AUTHORIZE_URL);
    // PKCE goes too. LinkedIn ignores it when the app does not use it.
    url.search = formBody({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state,
      scope: LINKEDIN_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: url.toString(), state, codeVerifier };
  }

  readonly authenticate = Effect.fn("LinkedInAdapter.authenticate")(function* (
    this: LinkedInAdapter,
    input: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string },
  ) {
    if (!input.clientSecret)
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.needsSecret", { network: NETWORK }),
      });
    const tokens = yield* this.#token({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const response = yield* contentRequest(this.#options, NETWORK, USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* linkedInError(response, body);
    if (!isDynamicRecord(body) || typeof body.sub !== "string" || !body.sub)
      return yield* new ContentAdapterError({
        code: "server",
        status: response.status,
        message: sourceText("error.content.noProfile", { network: NETWORK }),
      });
    const name = typeof body.name === "string" && body.name ? body.name : null;
    return { tokens, profile: { externalAccountId: body.sub, handle: name ?? body.sub, displayName: name } };
  });

  readonly refreshToken = Effect.fn("LinkedInAdapter.refreshToken")(function* (
    this: LinkedInAdapter,
    input: { clientId: string; clientSecret: string | null; refreshToken: string },
  ) {
    if (!input.refreshToken || !input.clientSecret)
      return yield* new ContentAdapterError({
        code: "signed-out",
        status: null,
        message: sourceText("error.content.signInAgainLinkedIn"),
      });
    return yield* this.#token({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  });

  readonly publish = Effect.fn("LinkedInAdapter.publish")(function* (
    this: LinkedInAdapter,
    input: {
      accessToken: string;
      profile: { externalAccountId: string };
      body: string;
      media: ContentPublishMedia | null;
    },
  ) {
    const author = `urn:li:person:${input.profile.externalAccountId}`;
    if (!input.media) return yield* this.#createPost(input.accessToken, author, input.body, null);
    if (!IMAGE_TYPES.has(input.media.mimeType))
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.linkedInImageType"),
      });
    const init = yield* contentRequest(this.#options, NETWORK, `${IMAGES_URL}?action=initializeUpload`, {
      method: "POST",
      headers: restHeaders(input.accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    });
    const initBody = yield* responseJson(init);
    if (!init.ok) return yield* linkedInError(init, initBody);
    const value = isDynamicRecord(initBody) && isDynamicRecord(initBody.value) ? initBody.value : null;
    if (typeof value?.uploadUrl !== "string" || typeof value.image !== "string")
      return yield* new ContentAdapterError({
        code: "server",
        status: init.status,
        message: sourceText("error.content.noUploadAddress", { network: NETWORK }),
      });
    const upload = yield* contentRequest(this.#options, NETWORK, value.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      body: input.media.bytes,
      timeoutMs: CONTENT_UPLOAD_TIMEOUT_MS,
    });
    if (!upload.ok) return yield* linkedInError(upload, yield* responseJson(upload));
    for (let poll = 0; poll < IMAGE_POLLS; poll += 1) {
      if (poll > 0) yield* Effect.promise(() => this.#options.sleep(IMAGE_POLL_MS));
      if (yield* this.#imageAvailable(input.accessToken, value.image))
        return yield* this.#createPost(input.accessToken, author, input.body, value.image);
    }
    return processingPending(
      { image: value.image, author, text: input.body, startedAt: this.#options.now().toISOString() },
      IMAGE_CHECK_AFTER_MS,
    );
  });

  readonly checkPostStatus = Effect.fn("LinkedInAdapter.checkPostStatus")(function* (
    this: LinkedInAdapter,
    input: { accessToken: string; pendingData: string },
  ) {
    const pending = decodePending(input.pendingData);
    if (!pending)
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.uploadStateInvalid", { network: NETWORK }),
      });
    if (!(yield* this.#imageAvailable(input.accessToken, pending.image))) {
      // Pending data from before `startedAt` starts its 24 h now.
      const startedAt = pending.startedAt ?? this.#options.now().toISOString();
      if (pendingExpired(startedAt, this.#options.now())) return yield* gaveUp(NETWORK);
      return processingPending({ ...pending, startedAt }, IMAGE_CHECK_AFTER_MS);
    }
    return yield* this.#createPost(input.accessToken, pending.author, pending.text, pending.image);
  });

  readonly #imageAvailable = Effect.fn("LinkedInAdapter.imageAvailable")(function* (
    this: LinkedInAdapter,
    accessToken: string,
    image: string,
  ) {
    const response = yield* contentRequest(this.#options, NETWORK, `${IMAGES_URL}/${encodeURIComponent(image)}`, {
      headers: restHeaders(accessToken),
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* linkedInError(response, body);
    const status = isDynamicRecord(body) ? body.status : null;
    if (status === "PROCESSING_FAILED")
      return yield* new ContentAdapterError({
        code: "rejected",
        status: null,
        message: sourceText("error.content.imageFailed", { network: NETWORK }),
      });
    return status === "AVAILABLE";
  });

  readonly #createPost = Effect.fn("LinkedInAdapter.createPost")(function* (
    this: LinkedInAdapter,
    accessToken: string,
    author: string,
    text: string,
    image: string | null,
  ) {
    const response = yield* contentRequest(this.#options, NETWORK, POSTS_URL, {
      method: "POST",
      headers: restHeaders(accessToken),
      body: JSON.stringify({
        author,
        commentary: escapeLinkedInCommentary(text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(image ? { content: { media: { id: image } } } : {}),
      }),
      creates: true,
    });
    if (!response.ok) return yield* linkedInError(response, yield* responseJson(response));
    const urn = response.headers.get("x-restli-id");
    if (!urn)
      return yield* new ContentAdapterError({
        code: "unknown-result",
        status: response.status,
        message: sourceText("error.content.noPostId", { network: NETWORK }),
      });
    const result: ContentPublishResult = {
      kind: "published",
      externalPostId: urn,
      url: `https://www.linkedin.com/feed/update/${urn}/`,
    };
    return result;
  });

  readonly #token = Effect.fn("LinkedInAdapter.token")(function* (
    this: LinkedInAdapter,
    grant: Record<string, string>,
  ) {
    const response = yield* contentRequest(this.#options, NETWORK, TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(grant),
    });
    const body = yield* responseJson(response);
    if (!response.ok) return yield* linkedInError(response, body, true);
    return yield* tokensOf(body, this.#options.now(), NETWORK);
  });
}

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

// `startedAt` is optional: pending data from before it has none.
const pendingSchema = z.object({
  image: z.string(),
  author: z.string(),
  text: z.string(),
  startedAt: z.string().optional(),
});

/** The data of an image that LinkedIn still processes, or null when it is not valid. */
function decodePending(value: string): z.infer<typeof pendingSchema> | null {
  try {
    return pendingSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The typed error of a LinkedIn answer that is not 2xx. Its body is `{ message, serviceErrorCode, status }`. */
function linkedInError(
  response: Response,
  body: unknown,
  tokenRequest = false,
): Effect.Effect<never, ContentAdapterError> {
  const status = response.status;
  const record = isDynamicRecord(body) ? body : {};
  const text = shortProviderText(record.message) ?? shortProviderText(record.error_description);
  const fail = (code: ContentAdapterError["code"], message: string) =>
    Effect.fail(new ContentAdapterError({ code, status, message }));
  const network = NETWORK;
  if (status === 401 || (tokenRequest && status === 400))
    return fail("signed-out", sourceText("error.content.signInAgainLinkedIn"));
  if (status === 409) return fail("rejected", sourceText("error.content.duplicate", { network }));
  if (status === 426) return fail("rejected", sourceText("error.content.apiVersionOld", { network }));
  if (status === 429) return fail("rate-limited", sourceText("error.content.rateLimitedLater", { network }));
  if (status >= 500)
    return fail("server", sourceText("error.content.serverError", { network, status: String(status) }));
  if (status === 403)
    return fail("rejected", sourceText("error.content.refusedPermission", { network, reason: text ?? "HTTP 403" }));
  return fail("rejected", sourceText("error.content.refusedPost", { network, reason: text ?? `HTTP ${status}` }));
}
