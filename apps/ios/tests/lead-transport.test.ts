import test from "node:test";
import assert from "node:assert/strict";
import { SecureFetcher, validateOrigin } from "../src/core/httpClient.ts";

// Security review: a redirect decision must be made BEFORE credentials leave the configured
// origin. Never recover from a native-fetch TypeError by retrying with redirect:'follow'.
// Verified SDK57 source: expo/ios/Fetch/NativeResponse.swift lines178-201 refuses redirects for
// manual/error modes with URLSession completionHandler(nil). Prefer a named expo/fetch import
// (lazy default import is fine for test isolation) instead of a switchable global RN fetch.
test("a failed native fetch never falls back to following redirects", async () => {
  const modes: Array<RequestRedirect | undefined> = [];
  const fetcher = new SecureFetcher("https://msn.example", async (_url, init) => {
    modes.push(init?.redirect);
    if (modes.length === 1) throw new TypeError("Native transport rejected the request");
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(fetcher.fetchJson("https://msn.example/api/tenants/team", { headers: { Authorization: "Bearer test-only-secret" } }));
  assert.equal(modes.length, 1, "A follow-mode retry can leak bearer credentials before any final-URL check");
  assert.ok(modes[0] === "manual" || modes[0] === "error");
});

test("all redirect responses are rejected before any response parsing", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const fetcher = new SecureFetcher("https://msn.example", async () => new Response("{}", { status, headers: { Location: "https://foreign.example/" } }));
    await assert.rejects(fetcher.fetchJson("https://msn.example/api/tenants/team", {}));
  }
});

test("bare origins cannot contain credentials, query strings, fragments or paths", () => {
  for (const value of ["https://user:secret@msn.example", "https://msn.example?token=secret", "https://msn.example#secret", "https://msn.example/path"]) {
    assert.throws(() => validateOrigin(value));
  }
  assert.equal(validateOrigin("https://msn.example").origin, "https://msn.example");
  assert.equal(validateOrigin("http://localhost:8787").origin, "http://localhost:8787");
});

test("SecureFetcher refuses a foreign target before forwarding authorization", async () => {
  let calls = 0;
  const fetcher = new SecureFetcher("https://msn.example", async () => { calls++; return new Response("{}", { status: 200 }); });
  await assert.rejects(fetcher.fetchJson("https://foreign.example/api/tenants/team", { headers: { Authorization: "Bearer test-only-secret" } }));
  assert.equal(calls, 0);
});
