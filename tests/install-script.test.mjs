// Behaviour of public/install.sh against a local fake GitHub releases server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const script = new URL("../public/install.sh", import.meta.url).pathname;
const VERSION = "v9.9.9";
const TARGET = "x86_64-unknown-linux-gnu";
const work = mkdtempSync(join(tmpdir(), "msn-install-test-"));
const assets = new Map();
let server;
let base;

function release(version, target, { corrupt = false, broken = false } = {}) {
  const stage = `msn-${version}-${target}`;
  const src = join(work, "build", stage);
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "msn"),
    broken
      ? "#!/bin/sh\necho \"msn: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found\" >&2\nexit 1\n"
      : `#!/bin/sh\necho "msn ${version.slice(1)}"\n`,
  );
  chmodSync(join(src, "msn"), 0o755);
  const tarball = join(work, "build", `${stage}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", join(work, "build"), stage]);
  const bytes = readFileSync(tarball);
  const digest = createHash("sha256")
    .update(corrupt ? Buffer.from("other") : bytes)
    .digest("hex");
  assets.set(`/download/${version}/${stage}.tar.gz`, bytes);
  assets.set(`/download/${version}/${stage}.tar.gz.sha256`, Buffer.from(`${digest}  ${stage}.tar.gz\n`));
}

before(async () => {
  release(VERSION, TARGET);
  release(VERSION, "aarch64-apple-darwin");
  release(VERSION, "x86_64-unknown-linux-musl");
  release("v1.0.0", TARGET, { corrupt: true });
  release("v2.0.0", TARGET, { broken: true });
  server = createServer((req, res) => {
    if (req.url === "/latest") {
      res.writeHead(302, { Location: `/tag/${VERSION}` }).end();
    } else if (req.url === `/tag/${VERSION}`) {
      res.writeHead(200).end("release page");
    } else if (assets.has(req.url)) {
      res.writeHead(200).end(assets.get(req.url));
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(work, { recursive: true, force: true });
});

function install(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("sh", [script, ...args], {
      env: { PATH: process.env.PATH, HOME: work, MSN_RELEASES_URL: base, MSN_TARGET: TARGET, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("installs the latest release into ~/.local/bin by default after verifying its checksum", async () => {
  const { code, stderr } = await install([]);
  assert.equal(code, 0, stderr);
  const binary = join(work, ".local", "bin", "msn");
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "msn 9.9.9");
  assert.match(stderr, /downloading msn v9\.9\.9 for x86_64-unknown-linux-gnu/);
  assert.match(stderr, /checksum verified/);
  assert.match(stderr, /is not on your PATH/);
});

test("--version, --dir and MSN_TARGET pick the release asset and destination", async () => {
  const dir = join(work, "pinned");
  const { code, stderr } = await install(["--version", "9.9.9", "--dir", dir], {
    MSN_TARGET: "aarch64-apple-darwin",
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.equal(code, 0, stderr);
  assert.ok(existsSync(join(dir, "msn")));
  assert.match(stderr, /for aarch64-apple-darwin/);
  assert.doesNotMatch(stderr, /not on your PATH/);
});

test("refuses a download whose checksum does not match and leaves no binary", async () => {
  const dir = join(work, "corrupt");
  const { code, stderr } = await install(["--version", "v1.0.0", "--dir", dir]);
  assert.equal(code, 1);
  assert.match(stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(dir, "msn")));
});

test("fails clearly when the release has no build for the platform", async () => {
  const { code, stderr } = await install(["--dir", join(work, "none")], {
    MSN_TARGET: "riscv64-unknown-linux-gnu",
  });
  assert.equal(code, 1);
  assert.match(stderr, /cannot download msn-v9\.9\.9-riscv64-unknown-linux-gnu\.tar\.gz/);
});

test("an unwritable directory fails with a --dir hint and never escalates", async () => {
  const blocker = join(work, "a-file");
  writeFileSync(blocker, "");
  const { code, stderr } = await install(["--dir", join(blocker, "bin")]);
  assert.equal(code, 1);
  assert.match(stderr, /Choose a directory you can write to with --dir \(no sudo needed\)/);
  const commands = readFileSync(script, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(commands, /(^|[;&|(]|\$\()\s*sudo\s/m);
});

test("a binary that cannot run on this system fails loudly and names the glibc floor", async () => {
  const { code, stderr } = await install(["--version", "v2.0.0", "--dir", join(work, "old-glibc")]);
  assert.equal(code, 1);
  assert.match(stderr, /does not run on this system/);
  assert.match(stderr, /GLIBC_2\.39' not found/);
  assert.match(stderr, /glibc 2\.28 or newer/);
  assert.match(stderr, /install\.sh \| MSN_TARGET=x86_64-unknown-linux-musl sh/);
  assert.match(stderr, /cargo install --git https:\/\/github\.com\/thehumanworks\/msn msn-cli/);
  assert.doesNotMatch(stderr, /installed msn 2\.0\.0 to/);
});

// Fake uname, ldd and getconf so detection sees another Linux system.
function fakeLinux(name, { arch = "x86_64", ldd, glibc }) {
  const bin = join(work, `fake-${name}`);
  mkdirSync(bin, { recursive: true });
  const tool = (file, body) => {
    writeFileSync(join(bin, file), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, file), 0o755);
  };
  tool("uname", `[ "$1" = -m ] && echo ${arch} || echo Linux`);
  tool("ldd", `echo "${ldd}" >&2`);
  tool("getconf", glibc ? `echo "glibc ${glibc}"` : "exit 1");
  return bin;
}

for (const [name, system, expected] of [
  ["debian-12", { ldd: "ldd (Debian GLIBC 2.36-9) 2.36", glibc: "2.36" }, "x86_64-unknown-linux-gnu"],
  ["glibc-floor", { ldd: "ldd (GNU libc) 2.28", glibc: "2.28" }, "x86_64-unknown-linux-gnu"],
  ["glibc-without-getconf", { ldd: "ldd (GNU libc) 2.36" }, "x86_64-unknown-linux-musl"],
  ["centos-7", { ldd: "ldd (GNU libc) 2.17", glibc: "2.17" }, "x86_64-unknown-linux-musl"],
  ["alpine", { ldd: "musl libc (x86_64)" }, "x86_64-unknown-linux-musl"],
  ["arm-alpine", { arch: "aarch64", ldd: "musl libc (aarch64)" }, "aarch64-unknown-linux-musl"],
]) {
  test(`detects ${expected} on ${name}`, async () => {
    const bin = fakeLinux(name, system);
    const { stderr } = await install(["--dir", join(work, `detect-${name}`)], {
      MSN_TARGET: "",
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.match(stderr, new RegExp(`downloading msn v9\\.9\\.9 for ${expected}\n`));
  });
}

test("a partially downloaded script runs nothing", async () => {
  const source = readFileSync(script, "utf8");
  const partial = join(work, "partial.sh");
  writeFileSync(partial, source.slice(0, source.indexOf('say "downloading') + 200));
  const result = await new Promise((resolve) => {
    const child = spawn("sh", [partial], {
      env: { PATH: process.env.PATH, HOME: join(work, "partial-home") },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /downloading/);
  assert.ok(!existsSync(join(work, "partial-home")));
});

test("the zsh PATH hint names ~/.zprofile", async () => {
  const { code, stderr } = await install(["--dir", join(work, "zsh")], { SHELL: "/bin/zsh" });
  assert.equal(code, 0, stderr);
  assert.match(stderr, />> ~\/\.zprofile/);
});

test("works with wget when curl is missing", async (t) => {
  const tools = join(work, "no-curl-bin");
  mkdirSync(tools, { recursive: true });
  const needed = ["sh", "uname", "mktemp", "cut", "tr", "tar", "gzip", "mkdir", "cp", "chmod", "mv", "rm"];
  const optional = ["sed", "tail", "grep", "ls", "ldd", "sha256sum", "shasum", "openssl", "wget"];
  const which = (name) => {
    try {
      return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  if (!which("wget")) return t.skip("wget is not installed");
  for (const name of [...needed, ...optional]) {
    const path = which(name);
    if (path) symlinkSync(path, join(tools, name));
  }
  const dir = join(work, "wget");
  const { code, stderr } = await install(["--dir", dir], { PATH: tools });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /downloading msn v9\.9\.9/);
  assert.ok(existsSync(join(dir, "msn")));
});
