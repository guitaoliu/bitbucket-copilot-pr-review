import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangedFile } from "../git/types.ts";
import { filterChangedFiles } from "./files.ts";
import {
	getRepoFileAccessDecision,
	matchesRepoPathPattern,
	normalizeRepoPath,
} from "./path-access.ts";

const reviewedFile: ChangedFile = {
	path: "src/service.ts",
	status: "modified",
	patch:
		"diff --git a/src/service.ts b/src/service.ts\n@@ -8,1 +10,2 @@\n-foo\n+bar\n+baz",
	changedLines: [10, 11],
	hunks: [
		{
			oldStart: 8,
			oldLines: 1,
			newStart: 10,
			newLines: 2,
			header: "",
			changedLines: [10, 11],
		},
	],
	additions: 2,
	deletions: 1,
	isBinary: false,
};

describe("filterChangedFiles", () => {
	it("skips generated files but reviews deletions", () => {
		const result = filterChangedFiles(
			[
				reviewedFile,
				{
					...reviewedFile,
					path: "pnpm-lock.yaml",
					changedLines: [1],
					status: "modified",
				},
				{
					...reviewedFile,
					path: "src/removed.ts",
					status: "deleted",
					changedLines: [],
				},
			],
			[],
		);

		assert.deepEqual(
			result.map((file) => file.path),
			["src/service.ts", "src/removed.ts"],
		);
	});

	it("skips files matching configured ignore globs", () => {
		const result = filterChangedFiles(
			[
				{ ...reviewedFile, path: "i18n/locales/en.json" },
				{ ...reviewedFile, path: "i18n/locales/app/fr/common.json" },
				{ ...reviewedFile, path: "src/i18n/locales.ts" },
			],
			["i18n/locales/**/*.json"],
		);

		assert.deepEqual(
			result.map((file) => file.path),
			["src/i18n/locales.ts"],
		);
	});

	it("skips renamed files when the source path is disallowed", () => {
		const result = filterChangedFiles(
			[
				{
					...reviewedFile,
					path: "src/safe.ts",
					oldPath: "config/.env.local",
					status: "renamed",
				},
			],
			[],
		);

		assert.deepEqual(result, []);
	});

	it("skips copied files when the source path is disallowed", () => {
		const result = filterChangedFiles(
			[
				{
					...reviewedFile,
					path: "src/copied.ts",
					oldPath: "config/.env.local",
					status: "copied",
				},
			],
			[],
		);

		assert.deepEqual(result, []);
	});
});

describe("repo path access decisions", () => {
	it("allows safe related file paths and normalizes them", () => {
		const decision = getRepoFileAccessDecision("src/../src/service.ts");

		assert.equal(decision.include, true);
		assert.equal(decision.normalizedPath, "src/service.ts");
	});

	it("rejects path traversal and secret-bearing paths", () => {
		const traversal = getRepoFileAccessDecision("../secrets.txt");
		const secret = getRepoFileAccessDecision("config/.env.local");
		const credentials = getRepoFileAccessDecision("config/credentials.json");
		const privateKey = getRepoFileAccessDecision("infra/id_rsa");
		const deployKey = getRepoFileAccessDecision("keys/deploy-key.pem");

		assert.equal(traversal.include, false);
		assert.match(traversal.reason ?? "", /repo-relative/);
		assert.equal(secret.include, false);
		assert.equal(secret.reason, "potential secret-bearing path");
		assert.equal(credentials.include, false);
		assert.equal(credentials.reason, "potential secret-bearing path");
		assert.equal(privateKey.include, false);
		assert.equal(privateKey.reason, "potential secret-bearing path");
		assert.equal(deployKey.include, false);
		assert.equal(deployKey.reason, "potential secret-bearing path");
	});

	it("rejects files nested under exact secret-bearing directories", () => {
		const secretChild = getRepoFileAccessDecision("config/secrets/api.txt");
		const credentialsChild = getRepoFileAccessDecision(
			"config/credentials/client.json",
		);
		const tokensChild = getRepoFileAccessDecision("infra/tokens/client.json");

		assert.equal(secretChild.include, false);
		assert.equal(secretChild.reason, "potential secret-bearing path");
		assert.equal(credentialsChild.include, false);
		assert.equal(credentialsChild.reason, "potential secret-bearing path");
		assert.equal(tokensChild.include, false);
		assert.equal(tokensChild.reason, "potential secret-bearing path");
	});

	it("allows ordinary auth source files", () => {
		const authFile = getRepoFileAccessDecision("src/auth.ts");
		const oauthFile = getRepoFileAccessDecision("src/oauth.ts");

		assert.equal(authFile.include, true);
		assert.equal(authFile.normalizedPath, "src/auth.ts");
		assert.equal(oauthFile.include, true);
		assert.equal(oauthFile.normalizedPath, "src/oauth.ts");
	});

	it("allows ordinary source files whose names merely contain secret-like substrings", () => {
		const tokenFile = getRepoFileAccessDecision("src/token.ts");
		const tokenizerFile = getRepoFileAccessDecision("src/tokenizer.ts");
		const credentialsProviderFile = getRepoFileAccessDecision(
			"src/credentials-provider.ts",
		);
		const secretaryFile = getRepoFileAccessDecision("src/secretary.ts");
		const serviceAccountingFile = getRepoFileAccessDecision(
			"src/service-accounting.ts",
		);
		assert.equal(tokenFile.include, true);
		assert.equal(tokenFile.normalizedPath, "src/token.ts");
		assert.equal(tokenizerFile.include, true);
		assert.equal(tokenizerFile.normalizedPath, "src/tokenizer.ts");
		assert.equal(credentialsProviderFile.include, true);
		assert.equal(
			credentialsProviderFile.normalizedPath,
			"src/credentials-provider.ts",
		);
		assert.equal(secretaryFile.include, true);
		assert.equal(secretaryFile.normalizedPath, "src/secretary.ts");
		assert.equal(serviceAccountingFile.include, true);
		assert.equal(
			serviceAccountingFile.normalizedPath,
			"src/service-accounting.ts",
		);
	});

	it("rejects paths that could escape the repository or change git pathspec meaning", () => {
		for (const unsafe of [
			"/etc/passwd",
			":(top)src",
			"C:/repo/file.ts",
			"src\\file.ts",
			"src/\u0000file.ts",
			"src/../../outside.ts",
			".",
		]) {
			assert.equal(getRepoFileAccessDecision(unsafe).include, false, unsafe);
		}
		assert.equal(normalizeRepoPath("./src//a.ts"), "src/a.ts");
		assert.equal(normalizeRepoPath("src/../.."), undefined);
	});

	it("matches exact paths, directory prefixes, and globs", () => {
		const files = [
			"AGENTS.md",
			"src/AGENTS.md",
			"src/example.ts",
			"test/example.test.ts",
		];
		const matching = (pattern: string) =>
			files.filter((file) => matchesRepoPathPattern(file, pattern));

		assert.deepEqual(matching("**/AGENTS.md"), ["AGENTS.md", "src/AGENTS.md"]);
		assert.deepEqual(matching("src/"), ["src/AGENTS.md", "src/example.ts"]);
		assert.deepEqual(matching("**/*.ts"), [
			"src/example.ts",
			"test/example.test.ts",
		]);
		assert.deepEqual(matching("."), files);
	});
});
