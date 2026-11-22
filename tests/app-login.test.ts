import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { digest } from "../src/http";

// Native app sign-in (ADR 0079): Access verifies the person on /login?app=CHALLENGE, the app gets
// a one-time code on msn://login, and exchanges it with its verifier for an account key.

const tenant = `account-${"a".repeat(48)}`;
const stub = () => env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
const hex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

async function start(verifier: string): Promise<string> {
  const result = await stub().startAppLogin("tomas@example.com", await digest(verifier));
  if (!("code" in result)) throw new Error("expected a code");
  return result.code;
}

async function exchange(input: Record<string, unknown>, headers: Record<string, string> = {}) {
  return exports.default.fetch("https://msn.test/api/account/app-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

describe("app sign-in", () => {
  it("exchanges a code once, with the right verifier, for a working owner key", async () => {
    const verifier = hex();
    const code = await start(verifier);
    const response = await exchange({ account: tenant, code, verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const connection = await response.json<{
      url: string;
      tenant: string;
      username: string;
      token: string;
      owner: boolean;
    }>();
    expect(connection).toMatchObject({
      url: "https://msn.test",
      tenant,
      username: "tomas@example.com",
      owner: true,
    });
    const channels = await exports.default.fetch(`https://msn.test/api/tenants/${tenant}/channels`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    expect(channels.status).toBe(200);
    const again = await exchange({ account: tenant, code, verifier });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: { code: "invalid_app_login" } });
  });

  it("a wrong verifier spends the code, so whoever sees a code cannot use it", async () => {
    const verifier = hex();
    const code = await start(verifier);
    expect((await exchange({ account: tenant, code, verifier: hex() })).status).toBe(401);
    expect((await exchange({ account: tenant, code, verifier })).status).toBe(401);
  });

  it("refuses malformed input, another account's code and cross-origin callers", async () => {
    const verifier = hex();
    const code = await start(verifier);
    for (const input of [
      { account: "workspace", code, verifier },
      { account: `account-${"b".repeat(48)}`, code, verifier },
      { account: tenant, code: "short", verifier },
      { account: tenant, code, verifier: "not-hex" },
      { account: tenant },
    ])
      expect((await exchange(input)).status).toBe(401);
    expect(
      (await exchange({ account: tenant, code, verifier }, { Origin: "https://foreign.test" })).status,
    ).toBe(403);
  });

  it("codes expire after two minutes", async () => {
    const verifier = hex();
    const code = await start(verifier);
    const hash = await digest(code);
    await runInDurableObject(stub(), (_, state) => {
      state.storage.sql.exec("UPDATE app_logins SET expiresMs = ? WHERE code_hash = ?", Date.now() - 1, hash);
    });
    expect((await exchange({ account: tenant, code, verifier })).status).toBe(401);
  });

  it("starting needs a SHA-256 hex challenge and caps unexchanged sign-ins", async () => {
    expect(await stub().startAppLogin("tomas@example.com", "nope")).toMatchObject({
      refused: { status: 400, code: "invalid_app_login" },
    });
    const other = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", `account-${"c".repeat(48)}`]));
    for (let i = 0; i < 20; i++) await other.startAppLogin("tomas@example.com", hex());
    expect(await other.startAppLogin("tomas@example.com", hex())).toMatchObject({
      refused: { status: 429, code: "app_login_quota" },
    });
  });

  it("/login?app= needs Cloudflare Access and a well-formed challenge", async () => {
    const login = env.ACCESS_LOGIN_URL;
    const missing = await exports.default.fetch(`${login}?app=${hex()}`, { redirect: "manual" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Location")).toBeNull();
    expect(await missing.json()).toMatchObject({ error: { code: "login_required" } });
    const forged = await exports.default.fetch(`${login}?app=${hex()}`, {
      redirect: "manual",
      headers: {
        "Cf-Access-Jwt-Assertion": "e30.e30.",
        "Cf-Access-Authenticated-User-Email": "x@example.com",
      },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("Location")).toBeNull();
    const bad = await exports.default.fetch(`${login}?app=nope`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_app_login" } });
  });

  it("the hop to the configured login host keeps a valid challenge and drops everything else", async () => {
    const challenge = hex();
    const kept = await exports.default.fetch(
      `https://msn.test/login?app=${challenge}&redirect=https://foreign.test`,
      {
        redirect: "manual",
      },
    );
    expect(kept.status).toBe(302);
    expect(kept.headers.get("Location")).toBe(`${env.ACCESS_LOGIN_URL}?app=${challenge}`);
    const dropped = await exports.default.fetch("https://msn.test/login?app=https://foreign.test", {
      redirect: "manual",
    });
    expect(dropped.headers.get("Location")).toBe(env.ACCESS_LOGIN_URL);
  });
});
