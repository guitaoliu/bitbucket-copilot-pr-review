import type { BitbucketRepoScope } from "./scope.ts";
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
	private readonly scope: BitbucketRepoScope;

	constructor(scope: BitbucketRepoScope) {
		this.scope = scope;
	}

	private reportPath(commitId: string, reportKey: string): string {
		return `${this.scope.insightsRepositoryPath}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}`;
	}

	async getReport(
		commitId: string,
		reportKey: string,
	): Promise<RawBitbucketCodeInsightsReport | undefined> {
		try {
			return await this.scope.transport.requestJson<RawBitbucketCodeInsightsReport>(
				this.reportPath(commitId, reportKey),
			);
		} catch (error) {
			if (error instanceof BitbucketApiError && error.statusCode === 404) {
				return undefined;
			}

			throw error;
		}
	}

	async putReport(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
	): Promise<void> {
		validateInsightReportPayload(report);
		this.scope.logger.info(
			`Publishing Code Insights report ${reportKey} for commit ${commitId}`,
		);
		await this.scope.transport.request(this.reportPath(commitId, reportKey), {
			method: "PUT",
			json: report,
		});
	}
}
