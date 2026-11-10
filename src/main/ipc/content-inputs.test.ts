// @vitest-environment node

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { describe, expect, it } from "vitest";
import {
  parseContentBeginConnect,
  parseContentCalendar,
  parseContentCreatePost,
  parseContentDeletePost,
  parseContentDisconnect,
  parseContentListPosts,
  parseContentMediaHost,
  parseContentPublishNow,
  parseContentSchedulePost,
  parseContentUpdatePost,
} from "./content-inputs";

const TIME = "2030-03-01T10:00:00+01:00";
const UTC = "2030-03-01T09:00:00.000Z";
const LONG_ID = "x".repeat(INPUT_LIMITS.identifier + 1);

describe("content payloads from the renderer", () => {
  it("parses a list request and refuses a bad range or limit", () => {
    expect(parseContentListPosts({})).toEqual({});
    expect(parseContentListPosts({ from: TIME, limit: 10 })).toEqual({ from: UTC, limit: 10 });
    for (const limit of [0, INPUT_LIMITS.contentPostsPage + 1, 1.5, "10"])
      expect(() => parseContentListPosts({ limit })).toThrow();
    expect(() => parseContentListPosts({ from: UTC, to: UTC })).toThrow();
    expect(() => parseContentListPosts({ from: "yesterday" })).toThrow();
    expect(() => parseContentListPosts({ cursor: "a" })).toThrow();
    expect(() => parseContentListPosts(null)).toThrow();
  });

  it("parses a new post and keeps only draft ids for media", () => {
    const input = {
      body: "Shipping v2",
      media: { draftId: "d1" },
      scheduledFor: TIME,
      timezone: "Europe/Warsaw",
      variants: [
        { platform: "x", body: "Short", skipped: false },
        { platform: "youtube", title: "Video", media: { draftId: "d2" } },
      ],
    };
    expect(parseContentCreatePost(input)).toEqual({ ...input, scheduledFor: UTC });
  });

  it.each([
    ["no body", { timezone: "UTC" }],
    ["an empty body", { body: "  ", timezone: "UTC" }],
    ["a body that is too long", { body: "x".repeat(INPUT_LIMITS.contentPostBody + 1), timezone: "UTC" }],
    ["a number body", { body: 7, timezone: "UTC" }],
    ["no time zone", { body: "Hi" }],
    ["an unknown time zone", { body: "Hi", timezone: "Mars/Olympus" }],
    ["a time with no offset", { body: "Hi", timezone: "UTC", scheduledFor: "2030-03-01T10:00:00" }],
    ["a media path", { body: "Hi", timezone: "UTC", media: { path: "/etc/passwd" } }],
    ["media bytes", { body: "Hi", timezone: "UTC", media: { draftId: "d1", bytes: [1, 2] } }],
    ["a draft id that is too long", { body: "Hi", timezone: "UTC", media: { draftId: LONG_ID } }],
    ["an unknown key", { body: "Hi", timezone: "UTC", approvalState: "approved" }],
    ["a bad platform", { body: "Hi", timezone: "UTC", variants: [{ platform: "myspace" }] }],
    ["two entries for one network", { body: "Hi", timezone: "UTC", variants: [{ platform: "x" }, { platform: "x" }] }],
    ["a title on X", { body: "Hi", timezone: "UTC", variants: [{ platform: "x", title: "T" }] }],
    [
      "a title that is too long",
      {
        body: "Hi",
        timezone: "UTC",
        variants: [{ platform: "youtube", title: "x".repeat(INPUT_LIMITS.contentVariantTitle + 1) }],
      },
    ],
    ["an unknown variant key", { body: "Hi", timezone: "UTC", variants: [{ platform: "x", status: "queued" }] }],
  ])("refuses a new post with %s", (_name, value) => {
    expect(() => parseContentCreatePost(value)).toThrow("Invalid content post.");
  });

  it("parses each update action and refuses a mismatched one", () => {
    expect(parseContentUpdatePost({ postId: "p1", action: "approve" })).toEqual({ postId: "p1", action: "approve" });
    expect(parseContentUpdatePost({ postId: "p1", action: "unschedule" })).toEqual({
      postId: "p1",
      action: "unschedule",
    });
    expect(parseContentUpdatePost({ postId: "p1", action: "retry", platform: "x" })).toEqual({
      postId: "p1",
      action: "retry",
      platform: "x",
    });
    const edit = {
      postId: "p1",
      action: "edit",
      body: "New",
      media: null,
      timezone: "UTC",
      variants: [{ platform: "x", body: null, skipped: true }],
    };
    expect(parseContentUpdatePost(edit)).toEqual(edit);
    expect(() => parseContentUpdatePost({ postId: "p1", action: "retry" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "p1", action: "approve", platform: "x" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "p1", action: "approve", body: "New" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "p1", action: "publish" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "", action: "approve" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: LONG_ID, action: "approve" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "p1", action: "retry", platform: "myspace" })).toThrow();
    expect(() => parseContentUpdatePost({ postId: "p1", action: "approve", extra: 1 })).toThrow();
  });

  it("parses a schedule, a publish and a delete", () => {
    expect(parseContentSchedulePost({ postId: "p1", scheduledFor: TIME })).toEqual({ postId: "p1", scheduledFor: UTC });
    expect(parseContentPublishNow({ postId: "p1" })).toEqual({ postId: "p1" });
    expect(parseContentDeletePost({ postId: "p1" })).toEqual({ postId: "p1" });
    expect(() => parseContentSchedulePost({ postId: "p1" })).toThrow();
    expect(() => parseContentSchedulePost({ postId: "p1", scheduledFor: "soon" })).toThrow();
    expect(() => parseContentPublishNow({ postId: 7 })).toThrow();
    expect(() => parseContentDeletePost({ postId: "p1", force: true })).toThrow();
    expect(() => parseContentDeletePost("p1")).toThrow();
  });

  it("limits the calendar range", () => {
    const from = "2030-03-01T00:00:00.000Z";
    const days = (count: number) => new Date(Date.parse(from) + count * 24 * 60 * 60 * 1000).toISOString();
    const range = { from, to: days(INPUT_LIMITS.contentCalendarDays) };
    expect(parseContentCalendar(range)).toEqual(range);
    expect(() => parseContentCalendar({ from, to: days(INPUT_LIMITS.contentCalendarDays + 1) })).toThrow();
    expect(() => parseContentCalendar({ from: days(1), to: from })).toThrow();
    expect(() => parseContentCalendar({ from })).toThrow();
    expect(() => parseContentCalendar({ from, to: "next week" })).toThrow();
    expect(() => parseContentCalendar({ ...range, timezone: "UTC" })).toThrow();
  });

  it("parses a sign-in and refuses a bad platform or a long secret", () => {
    expect(parseContentBeginConnect({ platform: "linkedin", clientId: "id", clientSecret: "secret" })).toEqual({
      platform: "linkedin",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(parseContentBeginConnect({ platform: "x" })).toEqual({ platform: "x" });
    expect(() => parseContentBeginConnect({ platform: "myspace" })).toThrow();
    expect(() => parseContentBeginConnect({ platform: "x", clientId: "" })).toThrow();
    expect(() =>
      parseContentBeginConnect({ platform: "x", clientSecret: "x".repeat(INPUT_LIMITS.mcpClientSecret + 1) }),
    ).toThrow();
    expect(() => parseContentBeginConnect({ platform: "x", redirectUri: "https://evil.example" })).toThrow();
  });

  it("parses an image host with no network, and refuses unsafe URLs and bad buckets", () => {
    const mediaHost = {
      endpoint: "https://account.r2.example.test",
      bucket: "content-bucket",
      publicBaseUrl: "https://pub.example.test/",
      accessKeyId: "access",
      secretAccessKey: "secret",
    };
    expect(parseContentMediaHost(mediaHost)).toEqual({ ...mediaHost, publicBaseUrl: "https://pub.example.test" });
    const { accessKeyId: _id, secretAccessKey: _secret, ...noKeys } = mediaHost;
    expect(parseContentMediaHost(noKeys)).not.toHaveProperty("accessKeyId");
    for (const bad of [
      { endpoint: "http://account.r2.example.test" },
      { endpoint: "https://user:pass@account.r2.example.test" },
      { publicBaseUrl: "https://pub.example.test/?token=1" },
      { publicBaseUrl: "https://pub.example.test/#x" },
      { publicBaseUrl: "javascript:alert(1)" },
      { bucket: "Content_Bucket" },
      { bucket: "ab" },
      { bucket: "-bucket" },
      { accessKeyId: "" },
      { secretAccessKey: "x".repeat(INPUT_LIMITS.mcpClientSecret + 1) },
      { region: "auto" },
      { platform: "instagram" },
    ])
      expect(() => parseContentMediaHost({ ...mediaHost, ...bad })).toThrow();
    // The sign-in no longer carries the host.
    expect(() => parseContentBeginConnect({ platform: "instagram", mediaHost })).toThrow();
  });

  it("parses a disconnect or a cancel, never both", () => {
    expect(parseContentDisconnect({ accountId: "a1" })).toEqual({ accountId: "a1" });
    expect(parseContentDisconnect({ platform: "x", cancel: true })).toEqual({ platform: "x", cancel: true });
    expect(() => parseContentDisconnect({ platform: "x", cancel: false })).toThrow();
    expect(() => parseContentDisconnect({ platform: "x" })).toThrow();
    expect(() => parseContentDisconnect({ accountId: "a1", cancel: true })).toThrow();
    expect(() => parseContentDisconnect({})).toThrow();
  });
});
