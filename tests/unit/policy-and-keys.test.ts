import { describe, it, expect } from "vitest";
import { matchesRoute, matchesMethod } from "@sentinel/shared";
import { generateApiKey, hashApiKey } from "@sentinel/database";

describe("policy route matching", () => {
  it("matches an exact route", () => {
    expect(matchesRoute("/login", "/login")).toBe(true);
    expect(matchesRoute("/login", "/logout")).toBe(false);
  });

  it("matches a wildcard route prefix", () => {
    expect(matchesRoute("/api/*", "/api/users")).toBe(true);
    expect(matchesRoute("/api/*", "/api/users/123")).toBe(true);
    expect(matchesRoute("/api/*", "/api")).toBe(true);
    expect(matchesRoute("/api/*", "/other")).toBe(false);
  });

  it("treats a bare '*' or '/*' as matching everything", () => {
    expect(matchesRoute("*", "/anything")).toBe(true);
    expect(matchesRoute("/*", "/anything")).toBe(true);
  });

  it("does not treat a wildcard prefix as matching an unrelated path with the same prefix text", () => {
    expect(matchesRoute("/api/*", "/apixyz")).toBe(false);
  });
});

describe("policy method matching", () => {
  it("matches exact methods case-insensitively", () => {
    expect(matchesMethod("POST", "post")).toBe(true);
    expect(matchesMethod("POST", "GET")).toBe(false);
  });

  it("wildcard method matches anything", () => {
    expect(matchesMethod("*", "DELETE")).toBe(true);
  });
});

describe("API key hashing", () => {
  it("generates a key with the expected prefix format", () => {
    const { rawKey, keyPrefix } = generateApiKey();
    expect(rawKey.startsWith("sk_live_")).toBe(true);
    expect(rawKey.startsWith(keyPrefix)).toBe(true);
  });

  it("produces a deterministic hash for the same key", () => {
    const { rawKey } = generateApiKey();
    expect(hashApiKey(rawKey)).toBe(hashApiKey(rawKey));
  });

  it("produces different hashes for different keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a.rawKey)).not.toBe(hashApiKey(b.rawKey));
  });

  it("never stores the raw key as the hash", () => {
    const { rawKey, keyHash } = generateApiKey();
    expect(keyHash).not.toBe(rawKey);
    expect(keyHash).toHaveLength(64); // sha256 hex digest length
  });
});
