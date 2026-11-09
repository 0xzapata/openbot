/**
 * The network accounts of the content manager, and the apps that they sign in through.
 *
 * The app of each network (client id and optional client secret) is in an encrypted JSON file in
 * userData. The tokens of an account are in `content_accounts`, as ciphertext of the userData cipher
 * (`safeStorage`, or the Linux key file). A token is decrypted only in memory, and each decrypted token
 * and client secret is registered for log redaction. No event and no log line holds a token.
 */

import { readFile, rm } from "node:fs/promises";
import { type ContentPlatform, isContentPlatform } from "@openbot/contracts/ipc-content";
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

export const CONTENT_APPS_FILE = "openbot-content-apps-v1.json";

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

/** Starts the callback listener of one sign-in. The E2E gives one that binds no port. */
export type ContentCallbackListen = (receive: (url: URL) => CallbackAnswer) => Promise<{ close: () => Promise<void> }>;

export interface ContentAccountsOptions {
  store: ContentStore;
  cipher: SecretStorageCipher;
  appsPath: string;
  adapters: readonly ContentAdapter[];
  openExternal: (url: string) => Promise<void>;
  listen: ContentCallbackListen;
  now: () => Date;
}

interface PendingSignIn {
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
  #pending: PendingSignIn | null = null;
  readonly #refreshing = new Map<string, Effect.Effect<string, ContentAdapterError>>();

  constructor(options: ContentAccountsOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#appsPath = options.appsPath;
    this.#adapters = new Map(options.adapters.map((adapter) => [adapter.platform, adapter]));
    this.#openExternal = options.openExternal;
    this.#listen = options.listen;
    this.#now = options.now;
  }

  get platforms(): ContentPlatform[] {
    return [...this.#adapters.keys()];
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
    if (!parsed.success) return yield* new ContentAccountError({ message: "The client id is missing." });
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
    if (!adapter) return yield* new ContentAccountError({ message: `OpenBot cannot post to ${name} yet.` });
    const app = yield* this.app(platform);
    if (!app) return yield* new ContentAccountError({ message: `Add the ${name} app first.` });
    if (!this.#cipher.canPersist())
      return yield* new ContentAccountError({ message: sourceText("error.app.secretStorageUnavailable") });
    const connected = this.#store.connectedAccount(platform);
    if (connected)
      return yield* new ContentAccountError({
        message: `${name} already has a connected account (${connected.handle}). Disconnect it first.`,
      });

    this.cancelConnect();
    const start = adapter.generateAuthUrl({ clientId: app.clientId, redirectUri: CONTENT_REDIRECT_URI });
    const pending: PendingSignIn = { state: start.state, code: Deferred.makeUnsafe() };
    this.#pending = pending;
    const code = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => this.#listen((url) => this.#receive(url)),
        catch: () =>
          new ContentAccountError({
            message: `OpenBot could not listen on port ${CONTENT_REDIRECT_PORT} for the sign-in. Close the program that uses it and try again.`,
          }),
      }),
      () =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.tryPromise({
            try: () => this.#openExternal(start.url),
            catch: () => new ContentAccountError({ message: "OpenBot could not open the browser." }),
          });
          return yield* Deferred.await(pending.code).pipe(
            Effect.timeoutOrElse({
              duration: CONNECT_DEADLINE_MS,
              orElse: () => Effect.fail(new ContentAccountError({ message: "The sign-in took too long. Try again." })),
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
          message: cause instanceof ContentStateError ? cause.message : "OpenBot could not save the account.",
        }),
    });
  });

  cancelConnect(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending)
      Deferred.doneUnsafe(
        pending.code,
        Effect.fail(new ContentAccountError({ message: "The sign-in was cancelled." })),
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
    const name = CONTENT_NETWORK_NAMES[account.platform];
    const signedOut = new ContentAdapterError({
      code: "signed-out",
      status: null,
      message: `Sign in to ${name} again.`,
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

  /**
   * The page that the browser shows. The checks of the request itself are in the listener.
   * ponytail: the page reuses the generic `error.mcp.redirect*` texts, because `CallbackAnswer` allows
   * only those keys. Widen the type and add `content.redirect*` keys if the page must name the network.
   */
  #receive(url: URL): CallbackAnswer {
    const pending = this.#pending;
    const state = url.searchParams.get("state");
    if (!pending || !state || state !== pending.state) return { status: 400, message: "error.mcp.redirectNoSignIn" };
    // One use: a second callback with this `state` finds no sign-in.
    this.#pending = null;
    if (url.searchParams.get("error")) {
      Deferred.doneUnsafe(
        pending.code,
        Effect.fail(new ContentAccountError({ message: "The network refused the sign-in. Try again." })),
      );
      return { status: 400, message: "error.mcp.redirectRefused" };
    }
    const code = url.searchParams.get("code");
    if (!code) {
      Deferred.doneUnsafe(pending.code, Effect.fail(new ContentAccountError({ message: "The sign-in sent no code." })));
      return { status: 400, message: "error.mcp.redirectNotSignIn" };
    }
    registerSecretValue(code);
    Deferred.doneUnsafe(pending.code, Effect.succeed(code));
    return { status: 200, message: "error.mcp.redirectSignedIn" };
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
    const unreadable = new ContentAccountError({ message: "OpenBot could not read the saved network apps." });
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
        const failed = new ContentAccountError({ message: "OpenBot could not save the network apps." });
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
