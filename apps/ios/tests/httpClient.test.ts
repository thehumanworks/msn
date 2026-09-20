import test from "node:test";
import assert from "node:assert/strict";
import { HttpClient, SecureFetcher, validateOrigin } from "../src/core/httpClient.ts";
import { ApiError, InsecureOriginError, NetworkError } from "../src/core/errors.ts";
import { startMockServer, TEST_TOKEN } from "./support/mockServer.ts";

test("validateOrigin accepts https and rejects plain http", () => {
  assert.doesNotThrow(() => validateOrigin("https://msn.example"));
  assert.throws(() => validateOrigin("http://msn.example"), InsecureOriginError);
});

test("validateOrigin allows the explicit localhost development exception", () => {
  assert.doesNotThrow(() => validateOrigin("http://localhost:8787"));
  assert.doesNotThrow(() => validateOrigin("http://127.0.0.1:8787"));
});

test("validateOrigin rejects a malformed URL and one with a path", () => {
  assert.throws(() => validateOrigin("not a url"), InsecureOriginError);
  assert.throws(() => validateOrigin("https://msn.example/some/path"), InsecureOriginError);
});

test("a real redirect response is refused, never followed transparently", async () => {
  const server = await startMockServer();
  const other = await startMockServer();
  try {
    const fetcher = new SecureFetcher(server.url, globalThis.fetch);
    await assert.rejects(
      () =>
        fetcher.fetchJson(`${server.url}/api/tenants/t/redirect-away?to=${encodeURIComponent(other.url)}`, {
          method: "GET",
        }),
      InsecureOriginError,
    );
  } finally {
    await server.close();
    await other.close();
  }
});

test("HttpClient parses a structured ApiError from an error response", async () => {
  const server = await startMockServer();
  try {
    const client = new HttpClient(server.url, "acme", "wrong-token", globalThis.fetch);
    await assert.rejects(() => client.request("/"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "unauthorized");
      assert.equal(error.isAuthExpired, true);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("HttpClient succeeds end-to-end against the mock server", async () => {
  const server = await startMockServer();
  try {
    const client = new HttpClient(server.url, "acme", TEST_TOKEN, globalThis.fetch);
    const identity = await client.request<{ tenant: string }>("/");
    assert.equal(identity.tenant, "acme");
  } finally {
    await server.close();
  }
});

test("an unsupported redirect mode fails closed without a follow retry", async () => {
  let calls = 0;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    throw new TypeError("Native transport failure");
  };
  const client = new HttpClient("https://msn.example", "acme", TEST_TOKEN, fetchImpl);
  await assert.rejects(() => client.request("/"), NetworkError);
  assert.equal(calls, 1);
});

test("a genuine network failure surfaces as NetworkError, not a hang", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const client = new HttpClient("https://msn.example", "acme", TEST_TOKEN, fetchImpl as never);
  await assert.rejects(() => client.request("/"), NetworkError);
});
