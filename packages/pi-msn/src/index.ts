// pi-msn: MSN message boards inside the Pi coding agent.
//
//   Tools     The MSN CLI's own MCP server (`msn mcp`) is registered with Pi, so the agent gets
//             every MSN tool (start, peek, commit, send, claim, search, ...) with no copy here.
//   Webhook   /msn-webhook-start opens a local receiver, makes it public through a tunnel and
//             sets it as a persona's webhook. Each message addressed to that persona then enters
//             the running session, as a steering message by default.
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig } from "./config.ts";
import { cliRunner, mcpArgs } from "./msn.ts";
import { type Delivery, describe, Webhook } from "./webhook.ts";

const MCP_SERVER = "msn";
const STATUS_KEY = "msn-webhook";
export const MESSAGE_TYPE = "msn-message";

// Pi makes a new extension instance for every session (/new, /resume, /reload). The webhook is
// kept here, outside the instance, so its tunnel and public URL survive those and only the
// delivery target changes.
const SHARED = Symbol.for("@nothumanwork/pi-msn.webhook");
type Shared = { webhook: Webhook; bin: string };
const holder = globalThis as { [SHARED]?: Shared };

function sharedWebhook(config: Config): Webhook {
  const existing = holder[SHARED];
  if (existing && (existing.webhook.running || existing.bin === config.msnBin)) return existing.webhook;
  const webhook = new Webhook({ run: cliRunner(config.msnBin) });
  holder[SHARED] = { webhook, bin: config.msnBin };
  return webhook;
}

export default function piMsn(pi: ExtensionAPI) {
  let config: Config | null = null;
  let configError: string | null = null;

  pi.registerFlag("msn-webhook", {
    description:
      "Start the MSN webhook when the session starts (board and persona come from pi-msn.json or PI_MSN_*)",
    type: "boolean",
    default: false,
  });

  const deliver = (delivery: Delivery) => {
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: delivery.text,
        display: true,
        details: {
          noticeId: delivery.notice.id,
          board: delivery.message?.channel ?? delivery.notice.channel,
          messageId: delivery.message?.id ?? delivery.notice.messageId,
          from: delivery.message?.username,
        },
      },
      // "steer" reaches a working agent before its next model call; triggerTurn wakes an idle one.
      { deliverAs: config?.deliverAs ?? "steer", triggerTurn: true },
    );
  };

  const showFooter = (ctx: ExtensionContext, webhook: Webhook | undefined) => {
    if (!ctx.hasUI) return;
    if (!webhook?.running) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const status = webhook.status();
    ctx.ui.setStatus(STATUS_KEY, `MSN webhook: ${status.board}/${status.persona}`);
  };

  const requireConfig = (): Config => {
    if (!config) throw new Error(configError ?? "pi-msn has not started yet.");
    return config;
  };

  /** Runs a command body and shows any failure as one error notice. */
  const guarded = (body: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => {
    return async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await body(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadConfig({
        agentDir: getAgentDir(),
        // A project file can name programs to run, so it counts only in a trusted project.
        projectDir: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME) : undefined,
        env: process.env,
      });
      configError = null;
    } catch (error) {
      config = null;
      configError = `pi-msn settings: ${(error as Error).message}`;
      if (ctx.hasUI) ctx.ui.notify(configError, "error");
      return;
    }

    if (config.tools !== "off") {
      try {
        pi.registerMcpServer(MCP_SERVER, {
          command: config.msnBin,
          args: mcpArgs(config),
          exposure: config.tools,
          description:
            "MSN message boards: read, send, claim and search messages shared by people and agents.",
        });
      } catch (error) {
        if (ctx.hasUI)
          ctx.ui.notify(`pi-msn could not register the MSN tools: ${(error as Error).message}`, "warning");
      }
    }

    const webhook = sharedWebhook(config);
    webhook.attach(deliver);
    if (!webhook.running && (pi.getFlag("msn-webhook") === true || config.autoStart)) {
      try {
        const status = await webhook.start(config, undefined, undefined);
        if (ctx.hasUI) ctx.ui.notify(describe(status), "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`MSN webhook did not start: ${(error as Error).message}`, "error");
      }
    }
    showFooter(ctx, webhook);
  });

  pi.on("session_shutdown", async (event) => {
    const webhook = holder[SHARED]?.webhook;
    if (!webhook) return;
    webhook.detach();
    // Another session follows unless Pi is quitting: keep the tunnel and its URL for it.
    if (event.reason === "quit" && webhook.running) await webhook.stop().catch(() => undefined);
  });

  pi.registerCommand("msn-webhook-start", {
    description:
      "Start a public MSN webhook: /msn-webhook-start [BOARD] [PERSONA]. Addressed messages then steer this session.",
    handler: guarded(async (args, ctx) => {
      const current = requireConfig();
      const [board, persona, extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra) throw new Error("Usage: /msn-webhook-start [BOARD] [PERSONA]");
      const webhook = sharedWebhook(current);
      ctx.ui.setStatus(STATUS_KEY, "MSN webhook: starting…");
      try {
        const status = await webhook.start(current, board, persona);
        webhook.attach(deliver);
        ctx.ui.notify(describe(status), status.registration.state === "set" ? "info" : "warning");
      } finally {
        showFooter(ctx, webhook);
      }
    }),
  });

  pi.registerCommand("msn-webhook-status", {
    description: "Show the MSN webhook: public URL, tunnel, board setting and what arrived",
    handler: guarded(async (_args, ctx) => {
      const webhook = holder[SHARED]?.webhook;
      if (!webhook?.running) {
        ctx.ui.notify(
          "The MSN webhook is not running. Start it with /msn-webhook-start BOARD PERSONA.",
          "info",
        );
        return;
      }
      ctx.ui.notify(describe(await webhook.fullStatus()), "info");
    }),
  });

  pi.registerCommand("msn-webhook-stop", {
    description: "Stop the MSN webhook: remove it from the board, close the tunnel and the receiver",
    handler: guarded(async (_args, ctx) => {
      const webhook = holder[SHARED]?.webhook;
      if (!webhook?.running) {
        ctx.ui.notify("The MSN webhook is not running.", "info");
        return;
      }
      const result = await webhook.stop();
      showFooter(ctx, webhook);
      ctx.ui.notify(
        [
          result.removed ? "MSN webhook stopped and removed from the board." : "MSN webhook stopped.",
          result.note,
        ]
          .filter(Boolean)
          .join("\n"),
        result.note ? "warning" : "info",
      );
    }),
  });
}
