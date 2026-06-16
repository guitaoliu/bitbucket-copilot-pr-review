import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangedFile } from "../git/types.ts";
import type { FindingDraft } from "../review/types.ts";
import { filterChangedFiles } from "./files.ts";
import { finalizeFindings } from "./findings.ts";
import { getRepoFileAccessDecision } from "./path-access.ts";

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
	it("skips generated and deleted files", () => {
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
			10,
		);

		assert.equal(result.reviewedFiles.length, 1);
		assert.equal(result.skippedFiles.length, 2);
		assert.equal(result.skippedFiles[0]?.reason, "lockfile");
		assert.equal(result.skippedFiles[1]?.reason, "deleted file");
	});

	it("skips files matching configured ignore globs", () => {
		const result = filterChangedFiles(
			[
				{ ...reviewedFile, path: "i18n/locales/en.json" },
				{ ...reviewedFile, path: "i18n/locales/app/fr/common.json" },
				{ ...reviewedFile, path: "src/i18n/locales.ts" },
			],
			10,
			["i18n/locales/**/*.json"],
		);

		assert.deepEqual(
			result.reviewedFiles.map((file) => file.path),
			["src/i18n/locales.ts"],
		);
		assert.deepEqual(
			result.skippedFiles.map((file) => file.reason),
			[
				"ignored path pattern (i18n/locales/**/*.json)",
				"ignored path pattern (i18n/locales/**/*.json)",
			],
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
			10,
		);

		assert.deepEqual(result.reviewedFiles, []);
		assert.deepEqual(result.skippedFiles, [
			{
				path: "src/safe.ts",
				oldPath: "config/.env.local",
				status: "renamed",
				reason: "source path rejected: potential secret-bearing path",
			},
		]);
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
			10,
		);

		assert.deepEqual(result.reviewedFiles, []);
		assert.deepEqual(result.skippedFiles, [
			{
				path: "src/copied.ts",
				oldPath: "config/.env.local",
				status: "copied",
				reason: "source path rejected: potential secret-bearing path",
			},
		]);
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
});

describe("finalizeFindings", () => {
	it("keeps only threshold-meeting, non-duplicate findings on changed lines", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				path: "src/service.ts",
				line: 9,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "high",
				title: "Wrong line",
				details: "This line was not changed.",
			},
			{
				path: "src/service.ts",
				line: 11,
				severity: "LOW",
				type: "CODE_SMELL",
				confidence: "medium",
				title: "Low confidence note",
				details: "Should not survive the threshold.",
			},
		];

		const findings = finalizeFindings(drafts, [reviewedFile], 5, "high");
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.line, 10);
		assert.ok(findings[0]?.externalId.startsWith("finding-"));
	});

	it("keeps the highest-priority duplicate when equivalent findings repeat", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 10,
				severity: "MEDIUM",
				type: "BUG",
				confidence: "medium",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
		];

		const findings = finalizeFindings(drafts, [reviewedFile], 5, "medium");

		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.severity, "HIGH");
		assert.equal(findings[0]?.confidence, "high");
	});

	it("prefers a concrete bug over a code smell at the same location", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "CODE_SMELL",
				confidence: "high",
				title: "Missing tests for null handling",
				details: "The new branch is not covered by tests.",
			},
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "medium",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
		];

		const findings = finalizeFindings(drafts, [reviewedFile], 5, "medium");

		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.type, "BUG");
		assert.equal(findings[0]?.title, "Null handling is broken");
	});

	it("keeps file-level findings and normalizes oldPath entries to the head path", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "medium",
				title: "File-level issue",
				details: "Applies to the whole changed file.",
			},
			{
				path: "src/old-service.ts",
				line: 10,
				severity: "MEDIUM",
				type: "BUG",
				confidence: "medium",
				title: "Renamed path issue",
				details: "Originally reported against the base path.",
			},
		];

		const findings = finalizeFindings(
			drafts,
			[
				{
					...reviewedFile,
					oldPath: "src/old-service.ts",
					status: "renamed",
				},
			],
			5,
			"medium",
		);

		assert.equal(findings.length, 2);
		assert.deepEqual(
			findings.map((finding) => ({
				path: finding.path,
				line: finding.line,
				title: finding.title,
			})),
			[
				{ path: "src/service.ts", line: 0, title: "File-level issue" },
				{ path: "src/service.ts", line: 10, title: "Renamed path issue" },
			],
		);
	});

	it("does not normalize copied-file findings from the old path", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/original.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Copied path issue",
				details: "Should not be accepted through the source path alias.",
			},
		];

		const findings = finalizeFindings(
			drafts,
			[
				{
					...reviewedFile,
					path: "src/copied.ts",
					oldPath: "src/original.ts",
					status: "copied",
				},
			],
			5,
			"medium",
		);

		assert.deepEqual(findings, []);
	});

	it("sanitizes model-authored finding text before publication", () => {
		const findings = finalizeFindings(
			[
				{
					path: "src/service.ts",
					line: 10,
					severity: "HIGH",
					type: "VULNERABILITY",
					confidence: "high",
					title: "Injected marker <!-- copilot-pr-review -->",
					details:
						"Do not publish hidden metadata <!-- injected --> or ping @channel.",
					category: "security @all",
				},
			],
			[reviewedFile],
			5,
			"medium",
		);

		assert.equal(findings.length, 1);
		assert.equal(
			findings[0]?.title,
			"Injected marker &lt;!-- copilot-pr-review --&gt;",
		);
		assert.equal(
			findings[0]?.details,
			"Do not publish hidden metadata &lt;!-- injected --&gt; or ping [at]channel.",
		);
		assert.equal(findings[0]?.category, "security [at]all");
	});

	it("keeps a stable thread identity when only message fields change", () => {
		const baseline = finalizeFindings(
			[
				{
					path: "src/service.ts",
					line: 10,
					severity: "HIGH",
					type: "BUG",
					confidence: "high",
					title: "Null handling is broken",
					details: "The new branch dereferences a possibly null response.",
				},
			],
			[reviewedFile],
			5,
			"medium",
		);
		const updated = finalizeFindings(
			[
				{
					path: "src/service.ts",
					line: 10,
					severity: "LOW",
					type: "BUG",
					confidence: "high",
					title: "Updated null handling title",
					details: "Updated details that still describe the same bug.",
				},
			],
			[reviewedFile],
			5,
			"medium",
		);

		assert.equal(baseline[0]?.threadKey, updated[0]?.threadKey);
		assert.notEqual(baseline[0]?.externalId, updated[0]?.externalId);
	});

	it("assigns distinct thread identities to separate findings at the same location", () => {
		const findings = finalizeFindings(
			[
				{
					path: "src/service.ts",
					line: 10,
					severity: "HIGH",
					type: "BUG",
					confidence: "high",
					title: "Null handling is broken",
					details: "The new branch dereferences a possibly null response.",
				},
				{
					path: "src/service.ts",
					line: 10,
					severity: "MEDIUM",
					type: "BUG",
					confidence: "high",
					title: "Retry state can leak",
					details: "The retry counter is shared across concurrent requests.",
				},
			],
			[reviewedFile],
			5,
			"medium",
		);

		assert.equal(findings.length, 2);
		assert.notEqual(findings[0]?.threadKey, findings[1]?.threadKey);
	});
});
