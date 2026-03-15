import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { BitbucketApiError } from "./transport.ts";
import type {
	InsightAnnotationPayload,
	InsightReportPayload,
	RawBitbucketAnnotationsResponse,
	RawBitbucketCodeInsightsReport,
	RawBitbucketInsightAnnotation,
} from "./types.ts";

const MAX_INSIGHT_REPORT_DATA_FIELDS = 6;

function normalizeInsightAnnotation(
	annotation: RawBitbucketInsightAnnotation,
): InsightAnnotationPayload | undefined {
	if (
		typeof annotation.externalId !== "string" ||
		annotation.externalId.length === 0 ||
		typeof annotation.message !== "string" ||
		annotation.message.length === 0 ||
		typeof annotation.severity !== "string"
	) {
		return undefined;
	}

	return omitUndefined({
		externalId: annotation.externalId,
		path: annotation.path,
		line: annotation.line,
		message: annotation.message,
		severity: annotation.severity,
		type: annotation.type,
		link: annotation.link,
	}) satisfies InsightAnnotationPayload;
}

function getAnnotationsPageAnnotations(
	payload: RawBitbucketAnnotationsResponse,
): RawBitbucketInsightAnnotation[] {
	return payload.annotations ?? payload.values ?? [];
}

function getAnnotationsPageCount(
	payload: RawBitbucketAnnotationsResponse,
): number {
	if (
		typeof payload.totalCount === "number" &&
		Number.isFinite(payload.totalCount)
	) {
		return payload.totalCount;
	}

	return getAnnotationsPageAnnotations(payload).length;
}

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

	async listCodeInsightsAnnotations(
		commitId: string,
		reportKey: string,
	): Promise<InsightAnnotationPayload[]> {
		let start = 0;
		const annotations: InsightAnnotationPayload[] = [];

		while (true) {
			const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}/annotations?limit=1000&start=${start}`;
			const payload =
				await this.requestJson<RawBitbucketAnnotationsResponse>(pathname);
			const pageAnnotations = getAnnotationsPageAnnotations(payload);

			if (payload.totalCount && pageAnnotations.length === 0) {
				this.logger.debug(
					`Bitbucket returned annotation totalCount=${payload.totalCount} but no annotation bodies for report ${reportKey} on commit ${commitId}`,
				);
			}

			for (const annotation of pageAnnotations) {
				const normalized = normalizeInsightAnnotation(annotation);
				if (normalized) {
					annotations.push(normalized);
				}
			}

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				return annotations;
			}

			start = payload.nextPageStart;
		}
	}

	async getCodeInsightsAnnotationCount(
		commitId: string,
		reportKey: string,
	): Promise<number> {
		let start = 0;
		let count = 0;

		while (true) {
			const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}/annotations?limit=1000&start=${start}`;
			const payload =
				await this.requestJson<RawBitbucketAnnotationsResponse>(pathname);

			count += getAnnotationsPageCount(payload);

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				return count;
			}

			start = payload.nextPageStart;
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

	async addAnnotations(
		commitId: string,
		reportKey: string,
		annotations: InsightAnnotationPayload[],
	): Promise<void> {
		if (annotations.length === 0) {
			return;
		}

		const pathname = `/rest/insights/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/commits/${encodeURIComponent(commitId)}/reports/${encodeURIComponent(reportKey)}/annotations`;
		await this.request(pathname, {
			method: "POST",
			body: JSON.stringify({ annotations }),
		});
	}

	async publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: InsightReportPayload,
		annotations: InsightAnnotationPayload[],
	): Promise<void> {
		this.logger.info(
			`Publishing Code Insights report ${reportKey} for commit ${commitId}`,
		);
		validateInsightReportPayload(report);
		await this.deleteReport(commitId, reportKey);
		await this.createReport(commitId, reportKey, report);
		await this.addAnnotations(commitId, reportKey, annotations);
	}
}
