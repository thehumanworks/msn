import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { messageLink } from "../src/core/links.ts";

test("a message link uses the bare origin and names no credential", () => {
  assert.equal(
    messageLink("https://msn.example", "acme", "general", 42),
    "https://msn.example/#board=acme/general&msg=42",
  );
  assert.equal(
    messageLink("https://msn.example/", "acme", "general", 42),
    "https://msn.example/#board=acme/general&msg=42",
  );
  assert.equal(
    messageLink("http://localhost:8787", "acme", "ops", 7),
    "http://localhost:8787/#board=acme/ops&msg=7",
  );
});
