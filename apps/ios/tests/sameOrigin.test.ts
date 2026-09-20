import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ApiClient, provisionWorkspace } from "../src/core/apiClient.ts";
import { InsecureOriginError } from "../src/core/errors.ts";
import { TEST_TOKEN } from "./support/mockServer.ts";

function respondingFrom(url: string, body: unknown = {}, status = 200) {
  return async () => {
    const response = new Response(JSON.stringify(body), { status });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

test("a response attributed to a foreign origin is refused (authenticated calls)", async () => {
  const api = new ApiClient("https://msn.example", "acme", TEST_TOKEN, respondingFrom("https://evil.example/api/tenants/acme", { tenant: "acme" }));
  await assert.rejects(() => api.getIdentity(), InsecureOriginError);
});

test("a response attributed to a foreign origin is refused (public onboarding calls)", async () => {
  await assert.rejects(
    () => provisionWorkspace("https://msn.example", "acme", "tomas", undefined, respondingFrom("https://evil.example/")),
    InsecureOriginError,
  );
});

test("tenant and channel path segments cannot escape the API prefix", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify({ channel: "x", created: false }), { status: 200 });
  };
  const api = new ApiClient("https://msn.example", "acme/../admin", TEST_TOKEN, fetchImpl);
  await api.createChannel("../../x").catch(() => undefined);
  assert.ok(seen.length === 1);
  const url = new URL(seen[0]);
  assert.equal(url.origin, "https://msn.example");
  assert.ok(url.pathname.startsWith("/api/tenants/acme%2F..%2Fadmin/channels/"));
  assert.ok(!url.pathname.includes("/../"));
});

test("the bearer token is never placed in a URL", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push(url);
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    return new Response(JSON.stringify({ tenant: "acme", username: null, usernamePrefix: null }), { status: 200 });
  };
  await new ApiClient("https://msn.example", "acme", TEST_TOKEN, fetchImpl).getIdentity();
  assert.ok(seen.every((u) => !u.includes(TEST_TOKEN)));
});
