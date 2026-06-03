import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { CodeInsightsApi } from "./code-insights.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { PullRequestApi } from "./pull-request.ts";
import { BitbucketTransport } from "./transport.ts";
import type {
	InsightAnnotationPayload,
	InsightReportPayload,
	PullRequestComment,
	PullRequestInfo,
	RawBitbucketCodeInsightsReport,
} from "./types.ts";

export class BitbucketClient {
	private readonly transport: BitbucketTransport;
	private readonly pullRequests: PullRequestApi;
	private readonly comments: PullRequestCommentsApi;
	private readonly codeInsights: CodeInsightsApi;

	constructor(config: ReviewerConfig["bitbucket"], logger: Logger) {
		this.transport = new BitbucketTransport(config);
		this.pullRequests = new PullRequestApi(
			config.projectKey,
			config.repoSlug,
			config.prId,
			this.transport.requestJson.bind(this.transport),
		);
		this.comments = new PullRequestCommentsApi(
			config.projectKey,
			config.repoSlug,
			config.prId,
			logger,
			this.transport.request.bind(this.transport),
			this.transport.requestJson.bind(this.transport),
		);
		this.codeInsights = new CodeInsightsApi(
			config.projectKey,
			config.repoSlug,
			logger,
			this.transport.request.bind(this.transport),
			this.transport.requestJson.bind(this.transport),
		);
	}

	async getPullRequest(): Promise<PullRequestInfo> {
		return this.pullRequests.getPullRequest();
	}

	async getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<RawBitbucketCodeInsightsReport | undefined> {
		return this.codeInsights.getCodeInsightsReport(commitId, reportKey);
	}

	async getCodeInsightsAnnotationCount(
		commitId: string,
		reportKey: string,
	): Promise<number> {
		return this.codeInsights.getCodeInsightsAnnotationCount(
			commitId,
			reportKey,
		);
	}

	async listCodeInsightsAnnotations(
		commitId: string,
		reportKey: string,
	): Promise<InsightAnnotationPayload[]> {
		return this.codeInsights.listCodeInsightsAnnotations(commitId, reportKey);
	}

	async listPullRequestComments(): Promise<PullRequestComment[]> {
		return this.comments.listPullRequestComments();
	}

	async findPullRequestCommentByTag(
		tag: string,
	): Promise<PullRequestComment | undefined> {
		return this.comments.findPullRequestCommentByTag(tag);
	}

	async createPullRequestComment(text: string): Promise<void> {
		return this.comments.createPullRequestComment(text);
	}

	async updatePullRequestComment(
		commentId: number,
		version: number,
		text: string,
	): Promise<void> {
		return this.comments.updatePullRequestComment(commentId, version, text);
	}

	async upsertPullRequestComment(
		tag: string,
		text: string,
		options?: {
			strategy?: ReviewerConfig["report"]["commentStrategy"];
		},
	): Promise<void> {
		return this.comments.upsertPullRequestComment(tag, text, options);
	}

	async deleteReport(commitId: string, reportKey: string): Promise<void> {
		return this.codeInsights.deleteReport(commitId, reportKey);
	}

	async createReport(
		commitId: string,
		reportKey: string,
		payload: InsightReportPayload,
	): Promise<void> {
		return this.codeInsights.createReport(commitId, reportKey, payload);
	}

	async addAnnotations(
		commitId: string,
		reportKey: string,
		annotations: InsightAnnotationPayload[],
	): Promise<void> {
		return this.codeInsights.addAnnotations(commitId, reportKey, annotations);
	}

	async publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
		annotations: InsightAnnotationPayload[],
	): Promise<void> {
		return this.codeInsights.publishCodeInsights(
			commitId,
			reportKey,
			report,
			annotations,
		);
	}
}
