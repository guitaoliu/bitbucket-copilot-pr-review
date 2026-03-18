import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("run-local-batch-review.sh", () => {
	it("exists and is executable", async () => {
		const scriptPath = path.resolve(
			process.cwd(),
			"scripts/run-local-batch-review.sh",
		);

		await access(scriptPath, fsConstants.X_OK);
	});

	it("contains the batch subcommand entrypoint", async () => {
		const scriptPath = path.resolve(
			process.cwd(),
			"scripts/run-local-batch-review.sh",
		);
		const scriptText = await readFile(scriptPath, "utf8");

		assert.match(scriptText, /declare -a REVIEW_ARGS=\(batch "\$REPO_URL"\)/);
		assert.match(scriptText, /node "\$REVIEWER_ROOT\/src\/cli\.ts"/);
		assert.match(scriptText, /MAX_PARALLEL/);
		assert.match(scriptText, /KEEP_WORKDIRS/);
	});
});
