/**
 * The image host of the content manager: Instagram and Threads take an image only from a public URL that
 * Meta fetches, so OpenBot puts the image in the user's own Cloudflare R2 bucket for one publish and
 * removes it after. The publisher of one claimed Instagram or Threads variant is the only caller of `put`.
 *
 * `R2MediaHost` is a minimal S3 client on the injected `fetch`, signed with AWS Signature Version 4.
 * It never lists the bucket and removes only one exact key that this code made.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { ContentAdapterError, type ContentFetch, contentRequest } from "./content-adapter";

/** The default values of the image host settings. Each one can be changed in the Accounts dialog. */
export const CONTENT_MEDIA_HOST_DEFAULTS = {
  endpoint: "https://40392de49b2bbcedca37e4a962440d2d.r2.cloudflarestorage.com",
  bucket: "dev-assets-bucket",
  // The r2.dev URL has a rate limit and Cloudflare does not intend it for production: a custom domain of
  // the bucket replaces it through the setting alone.
  publicBaseUrl: "https://pub-451ea606e71242028630e5aadc8cd8aa.r2.dev",
} as const;

export interface ContentMediaHostSettings {
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The only keys that OpenBot writes or removes: one publish image, or one probe file. */
const HOSTED_KEY = /^t\/[0-9a-f]{32}\.(jpg|png|webp|gif)$/u;
const PROBE_KEY = /^t\/probe-[0-9a-f]{32}\.txt$/u;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isContentHostedKey(key: string): boolean {
  return HOSTED_KEY.test(key) || PROBE_KEY.test(key);
}

/** A new random key: 128 random bits and the extension. No file name, user, agent, post or variant id. */
export function contentHostedKey(mimeType: string): string | null {
  const extension = EXTENSIONS[mimeType];
  return extension ? `t/${randomBytes(16).toString("hex")}.${extension}` : null;
}

export const CONTENT_MEDIA_HOST_PROBE_FAILURES = ["upload", "public", "bytes"] as const;

/** The save-time check failed. `message` tells the user what to change. */
export class ContentMediaHostError extends Schema.TaggedError<ContentMediaHostError>()("ContentMediaHostError", {
  reason: Schema.Literals(CONTENT_MEDIA_HOST_PROBE_FAILURES),
  message: Schema.String,
}) {}

export interface ContentMediaHost {
  put(
    file: { bytes: Uint8Array<ArrayBuffer>; mimeType: string },
    key: string,
  ): Effect.Effect<{ url: string }, ContentAdapterError>;
  remove(key: string): Effect.Effect<void, ContentAdapterError>;
  /** Puts a small file, reads it back over the public URL, and removes it. */
  probe(): Effect.Effect<void, ContentMediaHostError>;
}

const NETWORK = "the image host";
const S3_REGION = "auto";

/** RFC 3986 encoding of one path segment, as SigV4 needs it. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The AWS Signature Version 4 headers of one S3 request with no query string. `headers` are signed too,
 * with `host`, `x-amz-date` and `x-amz-content-sha256`.
 */
export function signS3Request(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim();
  const names = Object.keys(headers).sort();
  const canonicalUri = url.pathname
    .split("/")
    .map((segment) => encodeSegment(decodeURIComponent(segment)))
    .join("/");
  const canonicalRequest = [
    input.method,
    canonicalUri,
    "",
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`,
  };
}

export interface R2MediaHostOptions {
  fetch: ContentFetch;
  now: () => Date;
  settings: ContentMediaHostSettings;
}

/** The user's Cloudflare R2 bucket, with path-style addresses: `<endpoint>/<bucket>/<key>`. */
export class R2MediaHost implements ContentMediaHost {
  readonly #fetch: ContentFetch;
  readonly #now: () => Date;
  readonly #settings: ContentMediaHostSettings;

  constructor(options: R2MediaHostOptions) {
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#settings = options.settings;
  }

  #objectUrl(key: string): string {
    return `${new URL(this.#settings.endpoint).origin}/${encodeSegment(this.#settings.bucket)}/${key}`;
  }

  publicUrl(key: string): string {
    return `${this.#settings.publicBaseUrl.replace(/\/+$/u, "")}/${key}`;
  }

  #request(method: "PUT" | "DELETE", key: string, body: Uint8Array<ArrayBuffer> | null, mimeType: string | null) {
    const url = this.#objectUrl(key);
    // ponytail: no `If-None-Match: *`, because R2 support for it on the S3 PutObject path is not confirmed
    // offline. 128 random bits make a key collision negligible; add the header after a check against R2.
    const headers = signS3Request({
      method,
      url,
      headers: mimeType ? { "content-type": mimeType } : {},
      payloadHash: sha256Hex(body ?? ""),
      accessKeyId: this.#settings.accessKeyId,
      secretAccessKey: this.#settings.secretAccessKey,
      region: S3_REGION,
      now: this.#now(),
    });
    return contentRequest({ fetch: this.#fetch }, NETWORK, url, { method, headers, ...(body ? { body } : {}) });
  }

  readonly put = Effect.fn("R2MediaHost.put")(function* (
    this: R2MediaHost,
    file: { bytes: Uint8Array<ArrayBuffer>; mimeType: string },
    key: string,
  ) {
    if (!isContentHostedKey(key)) return yield* refusedKey();
    const response = yield* this.#request("PUT", key, file.bytes, file.mimeType).pipe(Effect.mapError(unreachable));
    if (!response.ok) return yield* refused(response.status);
    return { url: this.publicUrl(key) };
  });

  /** One DeleteObject of one exact key. A missing object counts as removed. */
  readonly remove = Effect.fn("R2MediaHost.remove")(function* (this: R2MediaHost, key: string) {
    if (!isContentHostedKey(key)) return yield* refusedKey();
    const response = yield* this.#request("DELETE", key, null, null).pipe(Effect.mapError(unreachable));
    if (!response.ok && response.status !== 404) return yield* refused(response.status);
  });

  readonly probe = Effect.fn("R2MediaHost.probe")(function* (this: R2MediaHost) {
    const id = randomBytes(16).toString("hex");
    const key = `t/probe-${id}.txt`;
    const bytes = new TextEncoder().encode(`OpenBot image host check ${id}\n`);
    const check = Effect.gen({ self: this }, function* () {
      const put = yield* this.#request("PUT", key, bytes, "text/plain").pipe(Effect.result);
      if (put._tag === "Failure" || !put.success.ok)
        return yield* new ContentMediaHostError({
          reason: "upload",
          message: sourceText("error.content.mediaHostUploadRefused", {
            status: put._tag === "Failure" ? "no answer" : String(put.success.status),
          }),
        });
      const read = yield* Effect.tryPromise(async () => {
        // A plain GET with no credentials, as Meta reads it.
        const response = await this.#fetch(this.publicUrl(key), { signal: AbortSignal.timeout(30_000) });
        return { status: response.status, body: response.ok ? new Uint8Array(await response.arrayBuffer()) : null };
      }).pipe(Effect.orElseSucceed(() => ({ status: 0, body: null })));
      if (read.status !== 200 || !read.body)
        return yield* new ContentMediaHostError({
          reason: "public",
          message: sourceText("error.content.mediaHostNotPublic", {
            status: read.status === 0 ? "no answer" : String(read.status),
          }),
        });
      if (Buffer.compare(Buffer.from(read.body), Buffer.from(bytes)) !== 0)
        return yield* new ContentMediaHostError({
          reason: "bytes",
          message: sourceText("error.content.mediaHostBytesDiffer"),
        });
    });
    // Removed on success and on failure. A failed upload made no object, so its DELETE finds none.
    yield* check.pipe(Effect.ensuring(this.remove(key).pipe(Effect.ignore)));
  });
}

function unreachable(): ContentAdapterError {
  return new ContentAdapterError({
    code: "network",
    status: null,
    message: sourceText("error.content.mediaHostUnreachable"),
  });
}

function refused(status: number): Effect.Effect<never, ContentAdapterError> {
  return Effect.fail(
    new ContentAdapterError({
      code: status >= 500 ? "server" : "rejected",
      status,
      message: sourceText("error.content.mediaHostRefused", { status: String(status) }),
    }),
  );
}

function refusedKey(): Effect.Effect<never, ContentAdapterError> {
  return Effect.fail(
    new ContentAdapterError({ code: "rejected", status: null, message: sourceText("error.content.mediaHostKey") }),
  );
}
