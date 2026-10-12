import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewerConfig } from "../../config/types.ts";
import type { ReviewableFile } from "../../git/types.ts";
import {
	buildFindingThreadKey,
	collectCurrentCodeKeys,
} from "../../policy/finding-identity.ts";
import type { ReviewFinding } from "../../policy/types.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../../shared/text.ts";
import { parseFindingCommentIdentity } from "../markers.ts";
import type { ReviewContext, ReviewOutcome } from "../types.ts";
import { buildFindingCommentDrafts } from "./finding-comment.ts";
import { buildInsightReport } from "./report.ts";
import { buildPullRequestComment } from "./summary-comment.ts";

const config: ReviewerConfig = {
	repoRoot: "/tmp/repo",
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "repo",
		prId: 123,
		auth: {
			type: "bearer",
			token: "token",
		},
		tls: {
			insecureSkipVerify: false,
		},
	},
	copilot: {
		model: "gpt-5.3-codex",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		minConfidence: "high",
		ignorePaths: [],
		skipBranchPrefixes: ["renovate/"],
	},
};

function createContext(prLink: string | undefined): ReviewContext {
	return {
		pr: {
			id: 123,
			version: 1,
			title: "Test PR",
			description: "Tighten request validation and clean up renamed paths.",
			...(prLink ? { link: prLink } : {}),
			source: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/feature",
				displayId: "feature",
				latestCommit: "head-123",
			},
			target: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/main",
				displayId: "main",
				latestCommit: "base-123",
			},
		},
		headCommit: "head-123",
		baseCommit: "base-123",
		mergeBaseCommit: "base-123",
		reviewRevision: "review-rev-123",
		diffStats: { fileCount: 6, additions: 4, deletions: 1 },
		reviewableFiles: [
			{
				path: "src/service.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "src/new-file.ts",
				status: "added",
				additions: 2,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "src/new-name.ts",
				oldPath: "src/old-name.ts",
				status: "renamed",
				additions: 1,
				deletions: 1,
				isBinary: false,
			},
		],
	};
}

function createOutcome(): ReviewOutcome {
	return {
		summary: "Found 2 issues.",
		prSummary:
			"Tightens request validation in the service flow and cleans up renamed modules before merge.",
		findings: [
			{
				externalId: "finding-1",
				threadKey: buildFindingThreadKey({
					path: "src/service.ts",
					line: 42,
					type: "BUG",
				}),
				path: "src/service.ts",
				line: 42,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				externalId: "finding-2",
				threadKey: buildFindingThreadKey({
					path: "src/new-name.ts",
					line: 0,
					type: "CODE_SMELL",
				}),
				path: "src/new-name.ts",
				line: 0,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "high",
				title: "Rename lost an import",
				details: "The renamed file no longer imports the shared helper.",
			},
		],
	};
}

describe("buildPullRequestComment", () => {
	it("shows when no validated findings were published", () => {
		const comment = buildPullRequestComment(config, createContext(undefined), {
			...createOutcome(),
			findings: [],
		});

		assert.match(
			comment,
			/### Findings\n- No validated reportable issues were published\./,
		);
		assert.doesNotMatch(comment, /### Change Areas/);
	});

	it("includes a PR summary and links changed files back to the pull request diff", () => {
		const prLink =
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";
		const comment = buildPullRequestComment(
			config,
			createContext(prLink),
			createOutcome(),
		);

		assert.doesNotMatch(comment, /### Conclusion/);
		assert.match(
			comment,
			/### What Changed\nTightens request validation in the service flow and cleans up renamed modules before merge\./,
		);
		assert.match(comment, /### Findings/);
		assert.match(comment, /- 2 reportable issues: 1 bug, 1 code smell/);
		assert.match(comment, /### Review Scope/);
		assert.match(
			comment,
			/- PR: \[#123 Test PR\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\); branches: `feature` -> `main`; diff: 6 files \(\+4\/-1\); reviewable: 3\./,
		);
		assert.doesNotMatch(comment, /- Change mix:/);
		assert.doesNotMatch(comment, /- Outside-scope reasons:/);
		assert.doesNotMatch(comment, /Changed files:/);
		assert.doesNotMatch(comment, /### Main Concerns/);
		assert.doesNotMatch(comment, /### Change Areas/);
		assert.doesNotMatch(comment, /### File Changes/);
		assert.doesNotMatch(comment, /Adds stricter null handling/);
		assert.match(
			comment,
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\] \[src\/service\.ts:42\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fservice\.ts\?t=42\) - Null handling is broken/,
		);
		assert.doesNotMatch(comment, /### Outside Review Scope/);
		assert.match(
			comment,
			/2\. \[Type: CODE_SMELL \| Severity: MEDIUM \| Confidence: high\] \[src\/new-name\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-name\.ts\) - Rename lost an import/,
		);
	});

	it("falls back to plain file references when the pull request link is unavailable", () => {
		const comment = buildPullRequestComment(
			config,
			createContext(undefined),
			createOutcome(),
		);

		assert.match(comment, /- PR: #123 Test PR/);
		assert.match(
			comment,
			/### What Changed\nTightens request validation in the service flow and cleans up renamed modules before merge\./,
		);
		assert.match(comment, /### Findings/);
		assert.doesNotMatch(comment, /### Conclusion/);
		assert.doesNotMatch(comment, /- Outside-scope reasons:/);
		assert.doesNotMatch(comment, /- `src\/service\.ts` - modified/);
		assert.doesNotMatch(comment, /### Main Concerns/);
		assert.doesNotMatch(comment, /### Change Areas/);
		assert.doesNotMatch(comment, /### File Changes/);
		assert.match(
			comment,
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\] `src\/service\.ts:42` - Null handling is broken/,
		);
		assert.doesNotMatch(comment, /### Outside Review Scope/);
		assert.doesNotMatch(comment, /\[src\/service\.ts:42\]\(/);
	});

	it("preserves bullet formatting in the What Changed section", () => {
		const comment = buildPullRequestComment(config, createContext(undefined), {
			...createOutcome(),
			prSummary:
				"- Tightens request validation in the service flow\n- Cleans up renamed module wiring before merge",
		});

		assert.match(
			comment,
			/### What Changed\n- Tightens request validation in the service flow\n- Cleans up renamed module wiring before merge/,
		);
	});

	function contextWithFiles(paths: string[]): ReviewContext {
		return {
			...createContext(
				"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			),
			reviewableFiles: paths.map((path) => ({
				path,
				status: "modified",
				additions: 1,
				deletions: 0,
				isBinary: false,
			})),
		};
	}

	function renderChangeArea(context: ReviewContext, paths: string[]): string {
		const comment = buildPullRequestComment(config, context, {
			...createOutcome(),
			changeAreas: [{ title: "Area *one*", paths, summary: "Does a thing." }],
		});
		const line = comment
			.split("\n")
			.find((entry) => entry.startsWith("- **Area"));
		assert.ok(line, comment);
		return line;
	}

	it("labels a change area by its shared directory and file count", () => {
		const context = contextWithFiles([
			"web/src/features/account/settings/panels/ProfileTab.tsx",
			"web/src/features/account/settings/panels/components/Picker.tsx",
			"lib/service/Api.java",
			"lib/service/ApiTest.java",
		]);

		assert.equal(
			renderChangeArea(context, [
				"web/src/features/account/settings/panels/ProfileTab.tsx",
				"web/src/features/account/settings/panels/components/Picker.tsx",
			]),
			"- **Area \\*one\\*** (`web/…/panels/`; 2 files): Does a thing.",
		);
		assert.equal(
			renderChangeArea(context, ["lib/service/*.java"]),
			"- **Area \\*one\\*** (`lib/service/`; 2 files): Does a thing.",
		);
	});

	it("labels a change area spanning modules by its top-level directories", () => {
		const context = contextWithFiles([
			"core/src/main/java/models/Entity.java",
			"users/src/main/java/service/Service.java",
			"users/src/test/java/service/ServiceTest.java",
			"ui/a.ts",
			"README.md",
		]);

		assert.equal(
			renderChangeArea(context, [
				"core/src/main/java/models/Entity.java",
				"users/src/main/java/service/Service.java",
				"users/src/test/java/service/ServiceTest.java",
			]),
			"- **Area \\*one\\*** (`core/`, `users/`; 3 files): Does a thing.",
		);
		assert.equal(
			renderChangeArea(context, ["."]),
			"- **Area \\*one\\*** (`core/`, `users/`, `ui/`, …; 5 files): Does a thing.",
		);
	});

	it("links a single-file change area to its diff by file name", () => {
		const context = contextWithFiles(["pages/[id].tsx", "src/other.ts"]);

		assert.equal(
			renderChangeArea(context, ["pages/[id].tsx"]),
			"- **Area \\*one\\*** ([\\[id\\].tsx](https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123/diff#pages%2F%5Bid%5D.tsx)): Does a thing.",
		);
	});

	it("adds taxonomy detail to the insight report summary", () => {
		const report = buildInsightReport(
			config,
			createContext(
				"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			),
			createOutcome(),
		);

		assert.match(
			report.details ?? "",
			/Only validated findings on reviewable changed files and changed lines are published\./,
		);
		assert.match(report.details ?? "", /Taxonomy: 1 bug, 1 code smell/);
		assert.match(report.details ?? "", /Top validated findings:/);
		assert.match(
			report.details ?? "",
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\] src\/service\.ts:42 - Null handling is broken/,
		);
		assert.deepEqual(
			report.data?.map(({ title, value }) => [title, value]),
			[
				["Findings", 2],
				["Review revision", "review-rev-123"],
				["Finding taxonomy", "1 bug, 1 code smell"],
				["Review scope", "3 reviewable"],
			],
		);
	});

	it("marks incomplete reviews as failed reports", () => {
		const report = buildInsightReport(config, createContext(undefined), {
			summary: "Repository context inspection was incomplete.",
			findings: [],
			incomplete: {
				reason: "Repository context inspection was incomplete.",
				failedTools: ["search_repo"],
			},
		});

		assert.equal(report.result, "FAIL");
	});

	it("truncates low-priority sections to stay under the Bitbucket comment limit", () => {
		const reviewableFiles = Array.from({ length: 180 }, (_, index) => ({
			path: `src/reviewed-${index}.ts`,
			status: "modified" as const,
			additions: 1,
			deletions: 0,
			isBinary: false,
		}));
		const context: ReviewContext = {
			...createContext(
				"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			),
			reviewableFiles,
			diffStats: {
				fileCount: reviewableFiles.length,
				additions: reviewableFiles.length,
				deletions: 0,
			},
		};

		const outcome: ReviewOutcome = {
			summary: "Found many issues.",
			prSummary: "Expands validation and support code across many modules.",
			findings: Array.from({ length: 120 }, (_, index) => ({
				externalId: `finding-${index}`,
				path:
					context.reviewableFiles[index % context.reviewableFiles.length]
						?.path ?? "src/service.ts",
				line: index + 1,
				severity: "HIGH" as const,
				type: "BUG" as const,
				confidence: "high" as const,
				threadKey: buildFindingThreadKey({
					path:
						context.reviewableFiles[index % context.reviewableFiles.length]
							?.path ?? "src/service.ts",
					line: index + 1,
					type: "BUG",
				}),
				title: `Important finding ${index} ${"z".repeat(240)}`,
				details: "Large review detail.",
			})),
		};

		const comment = buildPullRequestComment(config, context, outcome);

		assert.ok(comment.length <= BITBUCKET_PR_COMMENT_MAX_CHARS);
		assert.match(comment, /<!-- copilot-pr-review -->/);
		assert.match(comment, /<!-- copilot-pr-review:revision:review-rev-123 -->/);
		assert.doesNotMatch(comment, /<!-- copilot-pr-review:findings-json:/);
		assert.match(comment, /### What Changed/);
		assert.match(comment, /### Review Scope/);
		assert.match(comment, /omitted to fit Bitbucket comment limit/);
	});
});

function reviewedFile(lines: Record<number, string>): ReviewableFile {
	const changedLineText = new Map(
		Object.entries(lines).map(([line, text]) => [Number(line), text]),
	);
	return {
		path: "src/service.ts",
		status: "modified",
		additions: changedLineText.size,
		deletions: 0,
		isBinary: false,
		changedLines: [...changedLineText.keys()],
		changedLineText,
	};
}

describe("buildFindingCommentDrafts", () => {
	const tag = "copilot-pr-review";
	const [finding] = createOutcome().findings as [ReviewFinding];
	const files = [reviewedFile({ 42: "\treturn  user.name;" })];

	it("renders key and code markers that parse back to the draft's primary key", () => {
		const [draft] = buildFindingCommentDrafts(tag, [finding], files);
		assert.ok(draft);
		const identity = parseFindingCommentIdentity(tag, draft.text);

		assert.equal(identity?.key, draft.keys[0]);
		assert.ok(identity?.codeKey);
		assert.ok(collectCurrentCodeKeys(files).has(identity.codeKey));
		assert.deepEqual(draft.keys.slice(1), [
			`thread:${finding.threadKey}`,
			`legacy:${finding.externalId}`,
		]);
		assert.deepEqual(draft.anchor, { path: finding.path, line: finding.line });
		assert.match(
			draft.text,
			/\*\*Type: BUG \| Severity: HIGH \| Confidence: high\*\*\n\n\*\*Null handling is broken\*\*\n\nLocation: `src\/service\.ts:42`/,
		);
		assert.doesNotMatch(draft.text, /finding-thread:|finding-revision/);
	});

	it("keeps the finding key when only the line number or whitespace changes", () => {
		const [original] = buildFindingCommentDrafts(tag, [finding], files);
		const [shifted] = buildFindingCommentDrafts(
			tag,
			[{ ...finding, line: 50 }],
			[reviewedFile({ 50: "return user.name;  " })],
		);

		assert.equal(shifted?.keys[0], original?.keys[0]);
		assert.notEqual(shifted?.text, original?.text);
	});

	it("changes the finding key when the flagged code or finding type changes", () => {
		const [original] = buildFindingCommentDrafts(tag, [finding], files);
		const [edited] = buildFindingCommentDrafts(
			tag,
			[finding],
			[reviewedFile({ 42: "return user?.name;" })],
		);
		const [retyped] = buildFindingCommentDrafts(
			tag,
			[{ ...finding, type: "VULNERABILITY" }],
			files,
		);

		assert.notEqual(edited?.keys[0], original?.keys[0]);
		assert.notEqual(retyped?.keys[0], original?.keys[0]);
	});

	it("gives repeated findings on identical code distinct keys in a stable order", () => {
		const repeated = [finding, { ...finding, line: 43, title: "Second issue" }];
		const twoLines = [
			reviewedFile({ 42: "return user.name;", 43: "return user.name;" }),
		];
		const first = buildFindingCommentDrafts(tag, repeated, twoLines);
		const second = buildFindingCommentDrafts(tag, repeated, twoLines);

		assert.notEqual(first[0]?.keys[0], first[1]?.keys[0]);
		assert.deepEqual(
			first.map((draft) => draft.keys[0]),
			second.map((draft) => draft.keys[0]),
		);
	});

	it("posts file-level findings as top-level comments keyed to the file", () => {
		const [draft] = buildFindingCommentDrafts(
			tag,
			[{ ...finding, line: 0 }],
			files,
		);
		assert.ok(draft);
		const codeKey = parseFindingCommentIdentity(tag, draft.text)?.codeKey;

		assert.equal(draft.anchor, undefined);
		assert.match(draft.text, /Location: `src\/service\.ts`/);
		assert.ok(codeKey && collectCurrentCodeKeys(files).has(codeKey));
		assert.equal(codeKey && collectCurrentCodeKeys([]).has(codeKey), false);
	});
});

describe("parseFindingCommentIdentity", () => {
	it("matches comments written by older versions through their legacy markers", () => {
		assert.deepEqual(
			parseFindingCommentIdentity(
				"copilot-pr-review",
				"<!-- copilot-pr-review:finding-thread:thread-1 -->\nbody",
			),
			{ key: "thread:thread-1" },
		);
		assert.deepEqual(
			parseFindingCommentIdentity(
				"copilot-pr-review",
				"<!-- copilot-pr-review:finding:old-id -->\nbody",
			),
			{ key: "legacy:old-id" },
		);
	});

	it("ignores comments without a finding marker for the tag", () => {
		assert.equal(
			parseFindingCommentIdentity(
				"copilot-pr-review",
				"<!-- other-tag:finding-key:abc -->\n<!-- copilot-pr-review -->",
			),
			undefined,
		);
	});
});
