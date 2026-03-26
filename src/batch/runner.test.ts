import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { Logger } from "../shared/logger.ts";
import { runBatchReview } from "./runner.ts";
import type { BatchReviewConfig } from "./types.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

const baseConfig: BatchReviewConfig = {
	repoId: "PROJ/my-repo",
	repositoryUrl: "https://bitbucket.example.com/projects/PROJ/repos/my-repo",
	tempRoot: "/tmp/batch",
	maxParallel: 2,
	keepWorkdirs: false,
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "my-repo",
		auth: {
			type: "bearer",
			token: "token",
		},
		tls: {
			insecureSkipVerify: true,
		},
	},
	review: {
		dryRun: true,
		forceReview: false,
		confirmRerun: false,
		skipBranchPrefixes: ["renovate/"],
	},
};

function createPullRequest(id: number, title: string): PullRequestInfo {
	return {
		id,
		version: 1,
		state: "OPEN",
		title,
		description: "",
		source: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "my-repo",
			cloneUrl: "https://bitbucket.example.com/scm/proj/my-repo.git",
			refId: `refs/heads/feature-${id}`,
			displayId: `feature-${id}`,
			latestCommit: `head-${id}`,
		},
		target: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "my-repo",
			cloneUrl: "https://bitbucket.example.com/scm/proj/my-repo.git",
			refId: "refs/heads/main",
			displayId: "main",
			latestCommit: `base-${id}`,
		},
	};
}

describe("runBatchReview", () => {
	it("returns an empty summary when there are no open pull requests", async () => {
		const output = await runBatchReview(baseConfig, logger, {
			createRepositoryClient: () => ({
				async listOpenPullRequests() {
					return [];
				},
			}),
		});

		assert.equal(output.totalOpenPullRequests, 0);
		assert.equal(output.reviewed, 0);
		assert.equal(output.failed, 0);
		assert.equal(output.metrics.workspaces.tempRoot, "/tmp/batch");
		assert.equal(output.metrics.workspaces.provisioned, 0);
		assert.deepEqual(output.results, []);
	});

	it("aggregates reviewed, skipped, and failed pull requests", async () => {
		const pullRequests = [
			createPullRequest(101, "Reviewed PR"),
			{
				...createPullRequest(102, "Skipped PR"),
				source: {
					...createPullRequest(102, "Skipped PR").source,
					displayId: "renovate/eslint-10.x",
				},
			},
			createPullRequest(103, "Failed PR"),
		];
		const mirrorClones: string[] = [];
		const cleanedRoots: string[] = [];
		const output = await runBatchReview(baseConfig, logger, {
			createRepositoryClient: () => ({
				async listOpenPullRequests() {
					return pullRequests;
				},
			}),
			resolveTempRoot: async () => "/tmp/batch-root",
			createWorkspace: async () => ({
				baseRoot: "/tmp/batch-root",
				runRoot: "/tmp/batch-root/run-1",
				cacheRoot: "/tmp/batch-root/.cache",
				repoRoot: "/tmp/batch-root/run-1/workspaces",
				repoCacheRoot: "/tmp/batch-root/.cache/PROJ-my-repo",
				mirrorRoot: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
			}),
			ensureMirrorClone: async ({ cloneUrl, workspace }) => {
				mirrorClones.push(cloneUrl);
				return {
					path: workspace.mirrorRoot,
					action: "refreshed",
					durationMs: 15,
					lockWaitMs: 3,
				};
			},
			provisionPullRequestWorkspace: async ({ pr }) => {
				const provisionDurationMs = pr.id - 90;
				const cleanupDurationMs = pr.id - 100;
				const metrics = {
					provisionDurationMs,
					cleanupDurationMs,
					retained: false,
				};
				return {
					workspaceRoot: `/tmp/workspaces/${pr.id}`,
					metrics,
					async cleanup() {
						metrics.cleanupDurationMs = cleanupDurationMs;
					},
				};
			},
			runWorkerForPullRequest: async ({ pr }) => {
				if (pr.id === 101) {
					return {
						context: {
							prId: 101,
							title: pr.title,
							sourceBranch: pr.source.displayId,
							targetBranch: pr.target.displayId,
							headCommit: pr.source.latestCommit,
							mergeBaseCommit: pr.target.latestCommit,
							reviewedFiles: 1,
							skippedFiles: 0,
						},
						review: { summary: "ok", findings: [], stale: false },
						report: {
							title: "Copilot PR Review",
							result: "PASS",
							reporter: "GitHub Copilot",
						},
						annotations: [],
						published: false,
						skipped: false,
					};
				}

				if (pr.id === 102) {
					return {
						context: {
							prId: 102,
							title: pr.title,
							sourceBranch: pr.source.displayId,
							targetBranch: pr.target.displayId,
							headCommit: pr.source.latestCommit,
							mergeBaseCommit: pr.target.latestCommit,
							reviewedFiles: 0,
							skippedFiles: 0,
						},
						review: { summary: "skipped", findings: [], stale: false },
						report: {
							title: "Copilot PR Review",
							result: "PASS",
							reporter: "GitHub Copilot",
						},
						annotations: [],
						published: false,
						skipped: true,
						skipReason: "already reviewed",
					};
				}

				throw new Error("worker failed");
			},
			cleanupBatchWorkspace: async ({ workspaceRoot }) => {
				cleanedRoots.push(workspaceRoot);
				return 0;
			},
			loadTrustedBatchReviewConfig: async (config) => config,
		});

		assert.deepEqual(mirrorClones, [
			"https://bitbucket.example.com/scm/proj/my-repo.git",
		]);
		assert.equal(output.totalOpenPullRequests, 3);
		assert.equal(output.reviewed, 1);
		assert.equal(output.skipped, 1);
		assert.equal(output.failed, 1);
		assert.deepEqual(output.metrics.mirror, {
			path: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
			action: "refreshed",
			durationMs: 15,
			lockWaitMs: 3,
		});
		assert.equal(output.metrics.workspaces.tempRoot, "/tmp/batch-root");
		assert.equal(output.metrics.workspaces.runRoot, "/tmp/batch-root/run-1");
		assert.equal(output.metrics.workspaces.provisioned, 2);
		assert.equal(output.metrics.workspaces.cleaned, 2);
		assert.equal(output.metrics.workspaces.retained, 0);
		assert.equal(output.metrics.workspaces.provisionDurationMsTotal, 24);
		assert.equal(output.metrics.workspaces.workspaceCleanupDurationMsTotal, 4);
		assert.equal(output.metrics.workspaces.runRootCleanupDurationMs, 0);
		assert.equal(output.metrics.workspaces.runRootRemoved, true);
		assert.equal(output.results[0]?.status, "reviewed");
		assert.deepEqual(output.results[0]?.workspace, {
			provisionDurationMs: 11,
			cleanupDurationMs: 1,
			retained: false,
		});
		assert.equal(output.results[1]?.status, "skipped");
		assert.equal(
			output.results[1]?.skipReason,
			"Skipping review because pull request #102 source branch renovate/eslint-10.x matches skip prefix renovate/.",
		);
		assert.equal(output.results[1]?.workspace, undefined);
		assert.equal(output.results[2]?.status, "failed");
		assert.deepEqual(output.results[2]?.workspace, {
			provisionDurationMs: 13,
			cleanupDurationMs: 3,
			retained: false,
		});
		assert.match(output.results[2]?.error ?? "", /worker failed/);
		assert.deepEqual(cleanedRoots, ["/tmp/batch-root/run-1"]);
	});

	it("uses configured skip branch prefixes in batch mode", async () => {
		const output = await runBatchReview(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					skipBranchPrefixes: ["deps/"],
				},
			},
			logger,
			{
				createRepositoryClient: () => ({
					async listOpenPullRequests() {
						return [
							{
								...createPullRequest(201, "Deps PR"),
								source: {
									...createPullRequest(201, "Deps PR").source,
									displayId: "deps/typescript-5.x",
								},
							},
						];
					},
				}),
				resolveTempRoot: async () => "/tmp/batch-root",
				createWorkspace: async () => ({
					baseRoot: "/tmp/batch-root",
					runRoot: "/tmp/batch-root/run-1",
					cacheRoot: "/tmp/batch-root/.cache",
					repoRoot: "/tmp/batch-root/run-1/workspaces",
					repoCacheRoot: "/tmp/batch-root/.cache/PROJ-my-repo",
					mirrorRoot: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
				}),
				ensureMirrorClone: async ({ workspace }) => ({
					path: workspace.mirrorRoot,
					action: "created",
					durationMs: 1,
					lockWaitMs: 0,
				}),
				provisionPullRequestWorkspace: async () => {
					throw new Error("workspace should not be created for skipped branch");
				},
				runWorkerForPullRequest: async () => {
					throw new Error("worker should not run for skipped branch");
				},
				cleanupBatchWorkspace: async () => 0,
				loadTrustedBatchReviewConfig: async (config) => config,
			},
		);

		assert.equal(output.reviewed, 0);
		assert.equal(output.skipped, 1);
		assert.equal(output.failed, 0);
		assert.equal(output.metrics.workspaces.provisioned, 0);
		assert.equal(
			output.results[0]?.skipReason,
			"Skipping review because pull request #201 source branch deps/typescript-5.x matches skip prefix deps/.",
		);
	});

	it("skips draft pull requests in batch mode before provisioning a workspace", async () => {
		const output = await runBatchReview(baseConfig, logger, {
			createRepositoryClient: () => ({
				async listOpenPullRequests() {
					return [
						{
							...createPullRequest(202, "Draft PR"),
							draft: true,
						},
					];
				},
			}),
			resolveTempRoot: async () => "/tmp/batch-root",
			createWorkspace: async () => ({
				baseRoot: "/tmp/batch-root",
				runRoot: "/tmp/batch-root/run-1",
				cacheRoot: "/tmp/batch-root/.cache",
				repoRoot: "/tmp/batch-root/run-1/workspaces",
				repoCacheRoot: "/tmp/batch-root/.cache/PROJ-my-repo",
				mirrorRoot: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
			}),
			ensureMirrorClone: async ({ workspace }) => ({
				path: workspace.mirrorRoot,
				action: "created",
				durationMs: 1,
				lockWaitMs: 0,
			}),
			provisionPullRequestWorkspace: async () => {
				throw new Error("workspace should not be created for draft PRs");
			},
			runWorkerForPullRequest: async () => {
				throw new Error("worker should not run for draft PRs");
			},
			cleanupBatchWorkspace: async () => 0,
			loadTrustedBatchReviewConfig: async (config) => config,
		});

		assert.equal(output.reviewed, 0);
		assert.equal(output.skipped, 1);
		assert.equal(output.failed, 0);
		assert.equal(output.metrics.workspaces.provisioned, 0);
		assert.equal(
			output.results[0]?.skipReason,
			"Skipping review because pull request #202 is a draft.",
		);
	});

	it("tracks retained workspaces when keepWorkdirs is enabled", async () => {
		const output = await runBatchReview(
			{
				...baseConfig,
				keepWorkdirs: true,
			},
			logger,
			{
				createRepositoryClient: () => ({
					async listOpenPullRequests() {
						return [createPullRequest(201, "Retained PR")];
					},
				}),
				resolveTempRoot: async () => "/tmp/batch-root",
				createWorkspace: async () => ({
					baseRoot: "/tmp/batch-root",
					runRoot: "/tmp/batch-root/run-keep",
					cacheRoot: "/tmp/batch-root/.cache",
					repoRoot: "/tmp/batch-root/run-keep/workspaces",
					repoCacheRoot: "/tmp/batch-root/.cache/PROJ-my-repo",
					mirrorRoot: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
				}),
				ensureMirrorClone: async ({ workspace }) => ({
					path: workspace.mirrorRoot,
					action: "created",
					durationMs: 20,
					lockWaitMs: 0,
				}),
				provisionPullRequestWorkspace: async ({ pr }) => {
					const metrics = {
						provisionDurationMs: 9,
						retained: false,
					};
					return {
						workspaceRoot: `/tmp/workspaces/${pr.id}`,
						metrics,
						async cleanup() {
							throw new Error("cleanup should not run");
						},
					};
				},
				runWorkerForPullRequest: async ({ pr }) => ({
					context: {
						prId: pr.id,
						title: pr.title,
						sourceBranch: pr.source.displayId,
						targetBranch: pr.target.displayId,
						headCommit: pr.source.latestCommit,
						mergeBaseCommit: pr.target.latestCommit,
						reviewedFiles: 1,
						skippedFiles: 0,
					},
					review: { summary: "ok", findings: [], stale: false },
					report: {
						title: "Copilot PR Review",
						result: "PASS",
						reporter: "GitHub Copilot",
					},
					annotations: [],
					published: false,
					skipped: false,
				}),
				cleanupBatchWorkspace: async () => 0,
				loadTrustedBatchReviewConfig: async (config) => config,
			},
		);

		assert.equal(output.metrics.workspaces.cleaned, 0);
		assert.equal(output.metrics.workspaces.retained, 1);
		assert.equal(output.metrics.workspaces.runRootRemoved, false);
		assert.deepEqual(output.results[0]?.workspace, {
			provisionDurationMs: 9,
			retained: true,
		});
	});

	it("logs batch progress milestones", async () => {
		const infoMessages: string[] = [];
		const logSpy: Logger = {
			...logger,
			info(message) {
				infoMessages.push(message);
			},
		};

		await runBatchReview(baseConfig, logSpy, {
			createRepositoryClient: () => ({
				async listOpenPullRequests() {
					return [createPullRequest(101, "Reviewed PR")];
				},
			}),
			resolveTempRoot: async () => "/tmp/batch-root",
			createWorkspace: async () => ({
				baseRoot: "/tmp/batch-root",
				runRoot: "/tmp/batch-root/run-1",
				cacheRoot: "/tmp/batch-root/.cache",
				repoRoot: "/tmp/batch-root/run-1/workspaces",
				repoCacheRoot: "/tmp/batch-root/.cache/PROJ-my-repo",
				mirrorRoot: "/tmp/batch-root/.cache/PROJ-my-repo/mirror.git",
			}),
			ensureMirrorClone: async ({ workspace }) => ({
				path: workspace.mirrorRoot,
				action: "refreshed",
				durationMs: 15,
				lockWaitMs: 2,
			}),
			provisionPullRequestWorkspace: async ({ pr }) => ({
				workspaceRoot: `/tmp/workspaces/${pr.id}`,
				metrics: {
					provisionDurationMs: 11,
					cleanupDurationMs: 1,
					retained: false,
				},
				async cleanup() {},
			}),
			runWorkerForPullRequest: async ({ pr }) => ({
				context: {
					prId: pr.id,
					title: pr.title,
					sourceBranch: pr.source.displayId,
					targetBranch: pr.target.displayId,
					headCommit: pr.source.latestCommit,
					mergeBaseCommit: pr.target.latestCommit,
					reviewedFiles: 1,
					skippedFiles: 0,
				},
				review: { summary: "ok", findings: [], stale: false },
				report: {
					title: "Copilot PR Review",
					result: "PASS",
					reporter: "GitHub Copilot",
				},
				annotations: [],
				published: false,
				skipped: false,
			}),
			cleanupBatchWorkspace: async () => 4,
			loadTrustedBatchReviewConfig: async (config) => config,
		});

		assert.ok(infoMessages.includes("Using batch temp root /tmp/batch-root"));
		assert.ok(
			infoMessages.includes("Discovered 1 open pull requests for PROJ/my-repo"),
		);
		assert.ok(
			infoMessages.includes(
				"Created batch run workspace at /tmp/batch-root/run-1",
			),
		);
		assert.ok(
			infoMessages.includes("Mirror cache refreshed in 15ms (lock wait 2ms)"),
		);
		assert.ok(
			infoMessages.some((message) =>
				message.includes("Starting PR 1/1: #101 Reviewed PR"),
			),
		);
		assert.ok(
			infoMessages.some((message) =>
				message.includes("Finished PR 1/1: #101 Reviewed PR -> reviewed in"),
			),
		);
		assert.ok(
			infoMessages.includes(
				"Batch review complete: 1 reviewed, 0 skipped, 0 failed",
			),
		);
		assert.ok(infoMessages.includes("Removed batch run workspace in 4ms"));
	});
});
