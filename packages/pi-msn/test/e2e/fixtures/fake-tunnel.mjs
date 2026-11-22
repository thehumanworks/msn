#!/usr/bin/env node
// A stand-in for a tunnel program: an https server on a free port that forwards to the local
// port given as the first argument, and prints its "public" URL like a real tunnel does.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";

const [port, key, cert] = process.argv.slice(2);
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (incoming, outgoing) => {
  const forward = request(
    {
      host: "127.0.0.1",
      port: Number(port),
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    },
  );
  forward.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forward);
});
server.listen(0, "127.0.0.1", () => {
  console.error("starting tunnel...");
  console.error(`Your tunnel is ready at https://localhost:${server.address().port} (forwarding)`);
});
process.on("SIGTERM", () => process.exit(0));
