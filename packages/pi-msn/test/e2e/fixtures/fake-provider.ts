// Registers a model served by the test's fake OpenAI-compatible server.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    baseUrl: process.env.FAKE_LLM_URL as string,
    apiKey: "FAKE_LLM_KEY",
    api: "openai-completions",
    models: [
      {
        id: "fake-1",
        name: "Fake model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
