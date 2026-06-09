import type { Logger } from "../shared/logger.ts";
import { BitbucketApiError } from "./transport.ts";
import type {
	InsightReportPayload,
	RawBitbucketCodeInsightsReport,
} from "./types.ts";

const MAX_INSIGHT_REPORT_DATA_FIELDS = 6;

function validateInsightReportPayload(payload: InsightReportPayload): void {
	if (
		payload.data !== undefined &&
		payload.data.length > MAX_INSIGHT_REPORT_DATA_FIELDS
	) {
		throw new Error(
			`Bitbucket Code Insights supports at most ${MAX_INSIGHT_REPORT_DATA_FIELDS} report data fields, but got ${payload.data.length}.`,
		);
	}
}

export class CodeInsightsApi {
	private readonly projectKey: string;
	private readonly repoSlug: string;
	private readonly logger: Logger;
	private readonly request: (
		pathname: string,
		init?: RequestInit,
	) => Promise<string>;
	private readonly requestJson: <T>(
		pathname: string,
		init?: RequestInit,
	) => Promise<T>;

	constructor(
		projectKey: string,
		repoSlug: string,
		logger: Logger,
		request: (pathname: string, init?: RequestInit) => Promise<string>,
		requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>,
	) {
		this.projectKey = projectKey;
		this.repoSlug = repoSlug;
		this.logger = logger;
		this.request = request;
		this.requestJson = requestJson;
	}

	async getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<RawBitbucketCodeInsightsReport | undefined> {
		const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}`;

		try {
			return await this.requestJson<RawBitbucketCodeInsightsReport>(pathname);
		} catch (error) {
			if (error instanceof BitbucketApiError && error.statusCode === 404) {
				return undefined;
			}

			throw error;
		}
	}

	async deleteReport(commitId: string, reportKey: string): Promise<void> {
		const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}`;

		try {
			await this.request(pathname, { method: "DELETE" });
		} catch (error) {
			if (error instanceof BitbucketApiError && error.statusCode === 404) {
				this.logger.debug(
					`No existing Code Insights report found for ${reportKey}`,
				);
				return;
			}
			throw error;
		}
	}

	async createReport(
		commitId: string,
		reportKey: string,
		payload: InsightReportPayload,
	): Promise<void> {
		validateInsightReportPayload(payload);
		const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}`;
		await this.request(pathname, {
			method: "PUT",
			body: JSON.stringify(payload),
		});
	}

	async publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
	): Promise<void> {
		this.logger.info(
			`Publishing Code Insights report ${reportKey} for commit ${commitId}`,
		);
		validateInsightReportPayload(report);
		await this.deleteReport(commitId, reportKey);
		await this.createReport(commitId, reportKey, report);
	}
}
