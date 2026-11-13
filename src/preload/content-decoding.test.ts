// @vitest-environment node

import { CONTENT_PLATFORM_KEYS } from "@openbot/contracts/ipc-content";
import { describe, expect, it } from "vitest";
import {
  decodeContentAccountsState,
  decodeContentCalendar,
  decodeContentChanged,
  decodeContentPost,
  decodeContentPosts,
} from "./content-decoding";

const MEDIA = { id: "m1", kind: "image", mimeType: "image/png", bytes: 16, name: "launch.png" };
const VARIANT = {
  id: "v1",
  platform: "x",
  accountId: null,
  body: null,
  title: null,
  media: null,
  status: "queued",
  attempt: 0,
  externalPostId: null,
  externalUrl: null,
  errorCode: null,
  error: null,
  publishedAt: null,
  createdAt: "2030-03-01T09:00:00.000Z",
  updatedAt: "2030-03-01T09:00:00.000Z",
};
const POST = {
  id: "p1",
  body: "Shipping v2",
  media: MEDIA,
  approvalState: "none",
  scheduledFor: "2030-03-01T10:00:00.000Z",
  timezone: "UTC",
  authorAgentId: null,
  createdAt: "2030-03-01T09:00:00.000Z",
  updatedAt: "2030-03-01T09:00:00.000Z",
  status: "queued",
  variants: [VARIANT],
};
const ACCOUNT = {
  id: "a1",
  platform: "x",
  handle: "openbot",
  displayName: null,
  status: "connected",
  expiresAt: null,
};
const network = (platform: string) => ({
  platform,
  available: platform === "x",
  app: { platform, configured: platform === "x", clientId: null, hasSecret: false, needsSecret: false },
  account: platform === "x" ? ACCOUNT : null,
});
const ACCOUNTS = { networks: CONTENT_PLATFORM_KEYS.map(network), connecting: null, secretStorage: true };

describe("content decoders", () => {
  it("keep valid views", () => {
    expect(decodeContentPost(POST)).toEqual(POST);
    expect(decodeContentPosts([POST])).toEqual([POST]);
    expect(decodeContentAccountsState(ACCOUNTS)).toEqual(ACCOUNTS);
    const calendar = { from: "2030-03-01T00:00:00.000Z", to: "2030-03-08T00:00:00.000Z", timezone: "UTC", posts: [] };
    expect(decodeContentCalendar(calendar)).toEqual(calendar);
    expect(decodeContentChanged({ postId: "p1" })).toEqual({ postId: "p1" });
    expect(decodeContentChanged({ accounts: true })).toEqual({ accounts: true });
  });

  it.each([
    ["a post with a stored file name", { ...POST, media: { ...MEDIA, file: "abc.png" } }],
    ["a variant with a stored file name", { ...POST, variants: [{ ...VARIANT, media: { ...MEDIA, file: "a.png" } }] }],
    ["a variant with pending data", { ...POST, variants: [{ ...VARIANT, pendingData: "{}" }] }],
    ["a post with a path", { ...POST, path: "/Users/ada/launch.png" }],
  ])("refuse %s", (_name, value) => {
    expect(() => decodeContentPost(value)).toThrow();
  });

  it.each([
    ["an account token", { ...ACCOUNT, tokenCiphertext: "c2VjcmV0" }],
    ["an account refresh token", { ...ACCOUNT, refreshCiphertext: "c2VjcmV0" }],
    ["an access token", { ...ACCOUNT, accessToken: "x-access-token" }],
  ])("refuse accounts with %s", (_name, account) => {
    const networks = ACCOUNTS.networks.map((item) => (item.platform === "x" ? { ...item, account } : item));
    expect(() => decodeContentAccountsState({ ...ACCOUNTS, networks })).toThrow();
  });

  it("keeps the step 4 fields and accepts their absence", () => {
    const processing = { ...POST, variants: [{ ...VARIANT, status: "publishing", pendingReason: "processing" }] };
    expect(decodeContentPost(processing)).toEqual(processing);
    const none = { ...POST, variants: [{ ...VARIANT, pendingReason: null }] };
    expect(decodeContentPost(none)).toEqual(none);
    const mediaHost = {
      configured: true,
      endpoint: "https://account.r2.example.test",
      bucket: "content-bucket",
      publicBaseUrl: "https://pub.example.test",
      hasKeys: true,
      leftover: [{ count: 2, endpointHost: "account.r2.example.test", bucket: "content-bucket" }],
    };
    expect(decodeContentAccountsState({ ...ACCOUNTS, mediaHost })).toEqual({ ...ACCOUNTS, mediaHost });
    const clean = { ...mediaHost, leftover: [] };
    expect(decodeContentAccountsState({ ...ACCOUNTS, mediaHost: clean })).toEqual({ ...ACCOUNTS, mediaHost: clean });
    expect(decodeContentAccountsState({ ...ACCOUNTS, mediaHost: null })).toEqual({ ...ACCOUNTS, mediaHost: null });
  });

  it.each([
    [
      "an unknown pending reason",
      () => decodeContentPost({ ...POST, variants: [{ ...VARIANT, pendingReason: "queued" }] }),
    ],
    [
      "an image host access key",
      () =>
        decodeContentAccountsState({
          ...ACCOUNTS,
          mediaHost: {
            configured: true,
            endpoint: "https://a",
            bucket: "b",
            publicBaseUrl: "https://p",
            hasKeys: true,
            leftover: [],
            accessKeyId: "k",
          },
        }),
    ],
    [
      "an image host secret",
      () =>
        decodeContentAccountsState({
          ...ACCOUNTS,
          mediaHost: {
            configured: true,
            endpoint: "https://a",
            bucket: "b",
            publicBaseUrl: "https://p",
            hasKeys: true,
            leftover: [],
            secretAccessKey: "s",
          },
        }),
    ],
    [
      "an image host with no leftover",
      () =>
        decodeContentAccountsState({
          ...ACCOUNTS,
          mediaHost: {
            configured: true,
            endpoint: "https://a",
            bucket: "b",
            publicBaseUrl: "https://p",
            hasKeys: true,
          },
        }),
    ],
    [
      "a leftover item with a key",
      () =>
        decodeContentAccountsState({
          ...ACCOUNTS,
          mediaHost: {
            configured: true,
            endpoint: "https://a",
            bucket: "b",
            publicBaseUrl: "https://p",
            hasKeys: true,
            leftover: [{ count: 1, endpointHost: "a", bucket: "b", key: "t/x.jpg" }],
          },
        }),
    ],
  ])("refuses %s", (_name, decode) => {
    expect(decode).toThrow();
  });

  it("refuses an app with a client secret", () => {
    const networks = ACCOUNTS.networks.map((item) => ({ ...item, app: { ...item.app, clientSecret: "secret" } }));
    expect(() => decodeContentAccountsState({ ...ACCOUNTS, networks })).toThrow();
  });

  it("refuses wrong types and unknown values", () => {
    expect(() => decodeContentPost({ ...POST, status: "sent" })).toThrow();
    expect(() => decodeContentPost({ ...POST, approvalState: "maybe" })).toThrow();
    expect(() => decodeContentPost({ ...POST, variants: [{ ...VARIANT, platform: "myspace" }] })).toThrow();
    expect(() => decodeContentPost({ ...POST, scheduledFor: 7 })).toThrow();
    expect(() => decodeContentPosts(POST)).toThrow();
    expect(() => decodeContentAccountsState({ ...ACCOUNTS, connecting: "myspace" })).toThrow();
    expect(() => decodeContentAccountsState({ ...ACCOUNTS, secretStorage: "yes" })).toThrow();
    expect(() => decodeContentChanged({ accounts: false })).toThrow();
    expect(() => decodeContentChanged({ postId: "p1", token: "x" })).toThrow();
  });
});
