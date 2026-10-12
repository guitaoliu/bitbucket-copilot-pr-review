import { CopilotClient, type SessionConfig } from "@github/copilot-sdk";

// Preloaded into the CLI under test: routes every Copilot session to the
// scripted OpenAI-compatible model through a BYOK provider.
const modelUrl = process.env.E2E_FAKE_MODEL_URL;
if (!modelUrl) {
	throw new Error("E2E_FAKE_MODEL_URL is required for the fake model preload.");
}

const createSession = CopilotClient.prototype.createSession;
CopilotClient.prototype.createSession = function (config: SessionConfig) {
	return createSession.call(this, {
		...config,
		model: "fake-model",
		provider: { type: "openai", baseUrl: modelUrl, apiKey: "e2e" },
	});
};
