/**
 * The network accounts of the content manager, and the apps that they sign in through.
 *
 * The app of each network (client id and optional client secret) is in an encrypted JSON file in
 * userData. The tokens of an account are in `content_accounts`, as ciphertext of the userData cipher
 * (`safeStorage`, or the Linux key file). A token is decrypted only in memory, and each decrypted token
 * and client secret is registered for log redaction. No event and no log line holds a token.
 */

import { readFile, rm } from "node:fs/promises";
import {
  type ContentMediaHostInput,
  type ContentMediaHostView,
  type ContentPlatform,
  isContentPlatform,
} from "@openbot/contracts/ipc-content";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Deferred, Effect, Schema, Semaphore } from "effect";
import { z } from "zod";
import { writeFileAtomically } from "../../backend/atomic-json-file";
import {
  CONTENT_NETWORK_NAMES,
  type ContentAccountRecord,
  ContentStateError,
  type ContentStore,
} from "../../backend/content/content-store";
import { isMissingFileError } from "../../backend/file-errors";
import type { LanguageService } from "../language-service";
import { type CallbackAnswer, startLoopbackCallbackServer } from "../loopback-callback-server";
import type { SecretStorageCipher } from "../secret-storage-cipher";
import { type ContentAdapter, ContentAdapterError } from "./content-adapter";
import {
  CONTENT_MEDIA_HOST_DEFAULTS,
  type ContentMediaHost,
  type ContentMediaHostSettings,
} from "./content-media-host";

export const CONTENT_APPS_FILE = "openbot-content-apps-v1.json";
/** The image host settings, encrypted as one value, as the apps file is. */
export const CONTENT_MEDIA_HOST_FILE = "openbot-content-media-host-v1.json";

/**
 * X and LinkedIn compare the registered callback exactly, so the port is fixed. 28417 is the MCP
 * listener. LinkedIn asks for https redirect addresses in its documents: whether it takes
 * `http://127.0.0.1` is not confirmed, and the user must test it when they register the app.
 */
export const CONTENT_REDIRECT_PORT = 28_418;
export const CONTENT_REDIRECT_PATH = "/content-auth";
export const CONTENT_REDIRECT_URI = `http://127.0.0.1:${CONTENT_REDIRECT_PORT}${CONTENT_REDIRECT_PATH}`;

const CONNECT_DEADLINE_MS = 5 * 60_000;
/** A token that ends in less than this is refreshed before a publish. */
export const CONTENT_REFRESH_MARGIN_MS = 60_000;

export class ContentAccountError extends Schema.TaggedError<ContentAccountError>()("ContentAccountError", {
  message: Schema.String,
}) {}

export interface ContentApp {
  clientId: string;
  clientSecret: string | null;
}

const appSchema = z.strictObject({ clientId: z.string().min(1), clientSecret: z.string().min(1).nullable() });
const appsFileSchema = z.object({ version: z.literal(1), apps: z.record(z.string(), z.string()) });
const mediaHostSchema = z.strictObject({
  endpoint: z.string().min(1),
  bucket: z.string().min(1),
  publicBaseUrl: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});
const mediaHostFileSchema = z.object({ version: z.literal(1), host: z.string() });

/** Starts the callback listener of one sign-in. The E2E gives one that binds no port. */
export type ContentCallbackListen = (receive: (url: URL) => CallbackAnswer) => Promise<{ close: () => Promise<void> }>;

export interface ContentAccountsOptions {
  store: ContentStore;
  cipher: SecretStorageCipher;
  appsPath: string;
  adapters: readonly ContentAdapter[];
  /** The encrypted image host settings file. */
  mediaHostPath: string;
  /** Makes the image host client of saved settings. The E2E gives one on a fake `fetch`. */
  mediaHost: (settings: ContentMediaHostSettings) => ContentMediaHost;
  openExternal: (url: string) => Promise<void>;
  listen: ContentCallbackListen;
  now: () => Date;
}

interface PendingSignIn {
  platform: ContentPlatform;
  state: string;
  code: Deferred.Deferred<string, ContentAccountError>;
}

/** Owns the app file, the sign-in of an account, and the decrypt and refresh of its tokens. */
export class ContentAccounts {
  readonly #store: ContentStore;
  readonly #cipher: SecretStorageCipher;
  readonly #appsPath: string;
  readonly #adapters: ReadonlyMap<ContentPlatform, ContentAdapter>;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #listen: ContentCallbackListen;
  readonly #now: () => Date;
  readonly #appWrites = Semaphore.makeUnsafe(1);
  readonly #mediaHostPath: string;
  readonly #makeMediaHost: (settings: ContentMediaHostSettings) => ContentMediaHost;
  /** The saved image host. `loadMediaHost` reads it at startup; a save replaces it. */
  #mediaHost: { settings: ContentMediaHostSettings; host: ContentMediaHost } | null = null;
  #pending: PendingSignIn | null = null;
  readonly #refreshing = new Map<string, Effect.Effect<string, ContentAdapterError>>();

  constructor(options: ContentAccountsOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#appsPath = options.appsPath;
    this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
    this.#mediaHostPath = options.mediaHostPath;
    this.#makeMediaHost = options.mediaHost;
    this.#openExternal = options.openExternal;
    this.#listen = options.listen;
    this.#now = options.now;
  }

  /**
   * The networks that this version can post to now: each one with an adapter. Instagram takes an image
   * only from a public URL, so it counts only while an image host is set up.
   */
  get platforms(): ContentPlatform[] {
    return [...this.#adapters.keys()].filter((platform) => platform !== "instagram" || this.#mediaHost !== null);
  }

  /** The image host, when the user set one up. */
  mediaHost(): ContentMediaHost | null {
    return this.#mediaHost?.host ?? null;
  }

  /** The image host settings for the renderer: never the access key or the secret. */
  mediaHostView(): ContentMediaHostView {
    const settings = this.#mediaHost?.settings;
    return {
      configured: settings !== undefined,
      endpoint: settings?.endpoint ?? CONTENT_MEDIA_HOST_DEFAULTS.endpoint,
      bucket: settings?.bucket ?? CONTENT_MEDIA_HOST_DEFAULTS.bucket,
      publicBaseUrl: settings?.publicBaseUrl ?? CONTENT_MEDIA_HOST_DEFAULTS.publicBaseUrl,
      hasKeys: settings !== undefined,
    };
  }

  /** Reads the saved image host at startup. A file that cannot be read leaves no host, and Instagram waits. */
  readonly loadMediaHost = Effect.fn("ContentAccounts.loadMediaHost")(function* (this: ContentAccounts) {
    const text = yield* Effect.tryPromise(() => readFile(this.#mediaHostPath, "utf8")).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (text === null) return;
    const settings = yield* Effect.try(() => {
      const file = mediaHostFileSchema.parse(JSON.parse(text));
      return mediaHostSchema.parse(JSON.parse(this.#cipher.decrypt(Buffer.from(file.host, "base64"))));
    }).pipe(Effect.orElseSucceed(() => null));
    if (!settings) return;
    registerSecretValue(settings.secretAccessKey);
    registerSecretValue(settings.accessKeyId);
    this.#mediaHost = { settings, host: this.#makeMediaHost(settings) };
  });

  /**
   * Checks the image host with these values, and saves them only when the check passes. An absent key
   * field takes the saved one. Nothing is saved on a failure.
   */
  readonly saveMediaHost = Effect.fn("ContentAccounts.saveMediaHost")(function* (
    this: ContentAccounts,
    input: ContentMediaHostInput,
  ) {
    const saved = this.#mediaHost?.settings;
    const accessKeyId = input.accessKeyId ?? saved?.accessKeyId;
    const secretAccessKey = input.secretAccessKey ?? saved?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey)
      return yield* new ContentAccountError({ message: sourceText("error.content.mediaHostKeysMissing") });
    registerSecretValue(secretAccessKey);
    registerSecretValue(accessKeyId);
    if (!this.#cipher.canPersist())
      return yield* new ContentAccountError({ message: sourceText("error.app.secretStorageUnavailable") });
    const settings: ContentMediaHostSettings = {
      endpoint: input.endpoint,
      bucket: input.bucket,
      publicBaseUrl: input.publicBaseUrl,
      accessKeyId,
      secretAccessKey,
    };
    const host = this.#makeMediaHost(settings);
    yield* host.probe().pipe(Effect.mapError((error) => new ContentAccountError({ message: error.message })));
    const encrypted = this.#cipher.encrypt(JSON.stringify(settings)).toString("base64");
    yield* this.#appWrites.withPermit(
      writeFileAtomically(this.#mediaHostPath, `${JSON.stringify({ version: 1, host: encrypted })}\n`, {
        createDirectory: true,
      }).pipe(
        Effect.mapError(() => new ContentAccountError({ message: sourceText("error.content.mediaHostSaveFailed") })),
      ),
    );
    this.#mediaHost = { settings, host };
  });

  /** The network of the sign-in that waits for the browser, if any. */
  get connecting(): ContentPlatform | null {
    return this.#pending?.platform ?? null;
  }

  get canPersist(): boolean {
    return this.#cipher.canPersist();
  }

  adapter(platform: ContentPlatform): ContentAdapter | null {
    return this.#adapters.get(platform) ?? null;
  }

  readonly app = Effect.fn("ContentAccounts.app")(function* (this: ContentAccounts, platform: ContentPlatform) {
    const apps = yield* this.#readApps();
    return apps.get(platform) ?? null;
  });

  readonly setApp = Effect.fn("ContentAccounts.setApp")(function* (
    this: ContentAccounts,
    platform: ContentPlatform,
    app: ContentApp,
  ) {
    const parsed = appSchema.safeParse(app);
    if (!parsed.success)
      return yield* new ContentAccountError({ message: sourceText("error.content.clientIdMissing") });
    yield* this.#changeApps((apps) => apps.set(platform, parsed.data));
  });

  readonly removeApp = Effect.fn("ContentAccounts.removeApp")(function* (
    this: ContentAccounts,
    platform: ContentPlatform,
  ) {
    yield* this.#changeApps((apps) => apps.delete(platform));
  });

  /**
   * Signs in to one network in the system browser. One sign-in at a time: a new one ends the one before.
   * The callback must come in 5 minutes, once, with the `state` of this sign-in.
   */
  readonly connect = Effect.fn("ContentAccounts.connect")(function* (this: ContentAccounts, platform: ContentPlatform) {
    const name = CONTENT_NETWORK_NAMES[platform];
    const adapter = this.#adapters.get(platform);
    if (!adapter)
      return yield* new ContentAccountError({ message: sourceText("error.content.notSupported", { network: name }) });
    const app = yield* this.app(platform);
    if (!app) return yield* new ContentAccountError({ message: sourceText("error.content.addApp", { network: name }) });
    if (!this.#cipher.canPersist())
      return yield* new ContentAccountError({ message: sourceText("error.app.secretStorageUnavailable") });
    const connected = this.#store.connectedAccount(platform);
    if (connected)
      return yield* new ContentAccountError({
        message: sourceText("error.content.accountTaken", { network: name, handle: connected.handle }),
      });

    this.cancelConnect();
    const start = adapter.generateAuthUrl({ clientId: app.clientId, redirectUri: CONTENT_REDIRECT_URI });
    const pending: PendingSignIn = { platform, state: start.state, code: Deferred.makeUnsafe() };
    this.#pending = pending;
    const code = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => this.#listen((url) => this.#receive(url)),
        catch: () =>
          new ContentAccountError({
            message: sourceText("error.content.portBusy", { port: String(CONTENT_REDIRECT_PORT) }),
          }),
      }),
      () =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.tryPromise({
            try: () => this.#openExternal(start.url),
            catch: () => new ContentAccountError({ message: sourceText("error.content.browserFailed") }),
          });
          return yield* Deferred.await(pending.code).pipe(
            Effect.timeoutOrElse({
              duration: CONNECT_DEADLINE_MS,
              orElse: () =>
                Effect.fail(new ContentAccountError({ message: sourceText("error.content.signInTimeout") })),
            }),
          );
        }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (this.#pending === pending) this.#pending = null;
            }),
          ),
        ),
    );
    // The networks take the code for a short time only (X: about 30 s), so it is exchanged at once.
    const { tokens, profile } = yield* adapter
      .authenticate({
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri: CONTENT_REDIRECT_URI,
        code,
        codeVerifier: start.codeVerifier,
      })
      .pipe(Effect.mapError((error) => new ContentAccountError({ message: error.message })));
    registerSecretValue(tokens.accessToken);
    if (tokens.refreshToken) registerSecretValue(tokens.refreshToken);
    return yield* Effect.try({
      try: () =>
        this.#store.saveAccount(
          {
            platform,
            externalAccountId: profile.externalAccountId,
            handle: profile.handle,
            displayName: profile.displayName,
            tokenCiphertext: this.#encrypt(tokens.accessToken),
            refreshCiphertext: tokens.refreshToken ? this.#encrypt(tokens.refreshToken) : null,
            scopes: tokens.scopes,
            expiresAt: tokens.expiresAt,
          },
          this.#now(),
        ),
      catch: (cause) =>
        new ContentAccountError({
          message: cause instanceof ContentStateError ? cause.message : sourceText("error.content.accountSaveFailed"),
        }),
    });
  });

  /** Ends the sign-in that waits for the browser: any one, or only the one of `platform`. */
  cancelConnect(platform?: ContentPlatform): void {
    const pending = this.#pending;
    if (!pending || (platform !== undefined && pending.platform !== platform)) return;
    this.#pending = null;
    Deferred.doneUnsafe(
      pending.code,
      Effect.fail(new ContentAccountError({ message: sourceText("error.content.signInCancelled") })),
    );
  }

  /** The row stays for the published posts that name it; its tokens are removed. */
  disconnect(accountId: string): void {
    this.#store.disconnectAccount(accountId, this.#now());
  }

  /** The access token of a connected account, decrypted in memory only. */
  accessToken(account: ContentAccountRecord): string {
    return this.#decrypt(account.tokenCiphertext);
  }

  /**
   * New tokens for one account. Calls for the same account at the same time share one request: a
   * network that rotates the refresh token refuses the second use of the old one.
   */
  refresh(account: ContentAccountRecord): Effect.Effect<string, ContentAdapterError> {
    // Decided when the Effect runs, not when it is built: `Effect.cached` keeps its first result, so a
    // cached Effect that outlives its flight would send an old refresh token for every later refresh.
    return Effect.suspend(() => {
      const running = this.#refreshing.get(account.id);
      if (running) return running;
      const flight = Effect.runSync(
        Effect.cached(
          this.#refresh(account).pipe(Effect.ensuring(Effect.sync(() => this.#refreshing.delete(account.id)))),
        ),
      );
      this.#refreshing.set(account.id, flight);
      return flight;
    });
  }

  readonly #refresh = Effect.fn("ContentAccounts.refresh")(function* (
    this: ContentAccounts,
    account: ContentAccountRecord,
  ) {
    const signedOut = new ContentAdapterError({
      code: "signed-out",
      status: null,
      message: signInAgain(account.platform),
    });
    const adapter = this.#adapters.get(account.platform);
    const app = yield* this.app(account.platform).pipe(Effect.catch(() => Effect.succeed(null)));
    const refreshToken = account.refreshCiphertext ? this.#decrypt(account.refreshCiphertext) : null;
    const tokens =
      adapter && app && refreshToken
        ? yield* adapter.refreshToken({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken })
        : yield* signedOut;
    registerSecretValue(tokens.accessToken);
    if (tokens.refreshToken) registerSecretValue(tokens.refreshToken);
    this.#store.updateAccountTokens(
      account.id,
      {
        tokenCiphertext: this.#encrypt(tokens.accessToken),
        // A network that sends a new refresh token has ended the old one.
        refreshCiphertext: tokens.refreshToken ? this.#encrypt(tokens.refreshToken) : account.refreshCiphertext,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes || account.scopes,
      },
      this.#now(),
    );
    return tokens.accessToken;
  });

  /** The page that the browser shows. The checks of the request itself are in the listener. */
  #receive(url: URL): CallbackAnswer {
    const pending = this.#pending;
    const state = url.searchParams.get("state");
    if (!pending || !state || state !== pending.state)
      return { status: 400, message: "error.content.redirectNoSignIn" };
    // One use: a second callback with this `state` finds no sign-in.
    this.#pending = null;
    if (url.searchParams.get("error")) {
      Deferred.doneUnsafe(
        pending.code,
        Effect.fail(new ContentAccountError({ message: sourceText("error.content.signInRefused") })),
      );
      return { status: 400, message: "error.content.redirectRefused" };
    }
    const code = url.searchParams.get("code");
    if (!code) {
      Deferred.doneUnsafe(
        pending.code,
        Effect.fail(new ContentAccountError({ message: sourceText("error.content.signInNoCode") })),
      );
      return { status: 400, message: "error.content.redirectNotSignIn" };
    }
    registerSecretValue(code);
    Deferred.doneUnsafe(pending.code, Effect.succeed(code));
    return { status: 200, message: "error.content.redirectSignedIn" };
  }

  #encrypt(value: string): string {
    return this.#cipher.encrypt(value).toString("base64");
  }

  #decrypt(value: string): string {
    const plain = this.#cipher.decrypt(Buffer.from(value, "base64"));
    registerSecretValue(plain);
    return plain;
  }

  /**
   * ponytail: a file that cannot be read or decrypted fails every app call, and a save does not replace
   * it. Keep unreadable entries, as `McpOAuthStore` does, if users report a keychain that refuses once.
   */
  readonly #readApps = Effect.fn("ContentAccounts.readApps")(function* (this: ContentAccounts) {
    const unreadable = new ContentAccountError({ message: sourceText("error.content.appsUnreadable") });
    const text = yield* Effect.tryPromise({
      try: () => readFile(this.#appsPath, "utf8"),
      catch: (cause) => cause,
    }).pipe(Effect.catch((cause) => (isMissingFileError(cause) ? Effect.succeed(null) : Effect.fail(unreadable))));
    const apps = new Map<ContentPlatform, ContentApp>();
    if (text === null) return apps;
    return yield* Effect.try({
      try: () => {
        const file = appsFileSchema.parse(JSON.parse(text));
        for (const [platform, encrypted] of Object.entries(file.apps)) {
          if (!isContentPlatform(platform)) continue;
          const app = appSchema.parse(JSON.parse(this.#cipher.decrypt(Buffer.from(encrypted, "base64"))));
          if (app.clientSecret) registerSecretValue(app.clientSecret);
          apps.set(platform, app);
        }
        return apps;
      },
      catch: () => unreadable,
    });
  });

  #changeApps(change: (apps: Map<ContentPlatform, ContentApp>) => void): Effect.Effect<void, ContentAccountError> {
    return this.#appWrites.withPermit(
      Effect.gen({ self: this }, function* () {
        if (!this.#cipher.canPersist())
          return yield* new ContentAccountError({ message: sourceText("error.app.secretStorageUnavailable") });
        const apps = yield* this.#readApps();
        change(apps);
        const failed = new ContentAccountError({ message: sourceText("error.content.appsSaveFailed") });
        if (apps.size === 0) {
          yield* Effect.tryPromise({ try: () => rm(this.#appsPath, { force: true }), catch: () => failed });
          return;
        }
        const encrypted: Record<string, string> = {};
        for (const [platform, app] of apps)
          encrypted[platform] = this.#cipher.encrypt(JSON.stringify(app)).toString("base64");
        yield* writeFileAtomically(this.#appsPath, `${JSON.stringify({ version: 1, apps: encrypted })}\n`, {
          createDirectory: true,
        }).pipe(Effect.mapError(() => failed));
      }),
    );
  }
}

/** "Sign in to X again." for each network, as one fixed key each, so no other template matches it. */
export function signInAgain(platform: ContentPlatform): string {
  switch (platform) {
    case "x":
      return sourceText("error.content.signInAgainX");
    case "linkedin":
      return sourceText("error.content.signInAgainLinkedIn");
    case "instagram":
      return sourceText("error.content.signInAgainInstagram");
    case "threads":
      return sourceText("error.content.signInAgainThreads");
    case "facebook_page":
      return sourceText("error.content.signInAgainFacebook");
    case "youtube":
      return sourceText("error.content.signInAgainYouTube");
  }
}

/** The real callback listener: the fixed loopback port, started for one sign-in and closed after it. */
export function contentCallbackListener(
  language: Pick<LanguageService, "locale" | "translate">,
): ContentCallbackListen {
  return (receive) =>
    startLoopbackCallbackServer({
      path: CONTENT_REDIRECT_PATH,
      receive,
      language,
      port: { exact: CONTENT_REDIRECT_PORT },
      noPort: () => new Error("The content sign-in listener was given no port."),
    });
}
