import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBundledCopilotCliPath } from "./cli-path.ts";

describe("resolveBundledCopilotCliPath", () => {
	it("resolves the installed @github/copilot CLI entry", () => {
		const cliPath = resolveBundledCopilotCliPath();

		assert.match(cliPath, /@github[\\/]copilot[\\/]index\.js$/);
	});

	it("throws a clear error when the runtime cannot be resolved", () => {
		assert.throws(
			() =>
				resolveBundledCopilotCliPath(() => {
					throw new Error("missing");
				}),
			/Unable to resolve the bundled @github\/copilot runtime/,
		);
	});

	it("throws a clear error when the resolved CLI entry is missing", () => {
		assert.throws(
			() =>
				resolveBundledCopilotCliPath(
					() => new URL("./sdk/index.js", "file:///tmp/fake-copilot/").href,
				),
			/Resolved bundled @github\/copilot CLI path does not exist/,
		);
	});
});
