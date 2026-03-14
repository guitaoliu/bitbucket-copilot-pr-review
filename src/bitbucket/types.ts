import type { AnnotationType, Severity } from "../review/types.ts";

export interface RawBitbucketLink {
	href: string;
	name?: string;
}

export interface RawBitbucketRepository {
	id: number;
	slug: string;
	name?: string;
	links?: {
		clone?: RawBitbucketLink[];
		self?: RawBitbucketLink[];
	};
	project: {
		key: string;
	};
}

export interface RawBitbucketRef {
	id: string;
	displayId: string;
	latestCommit: string;
	latestChangeset?: string;
	repository: RawBitbucketRepository;
}

export interface RawBitbucketPullRequest {
	id: number;
	version: number;
	state?: string;
	title: string;
	description?: string | null;
	links?: {
		self?: RawBitbucketLink[];
	};
	fromRef: RawBitbucketRef;
	toRef: RawBitbucketRef;
}

export interface PullRequestSide {
	repositoryId: number;
	projectKey: string;
	repoSlug: string;
	cloneUrl?: string;
	refId: string;
	displayId: string;
	latestCommit: string;
}

export interface PullRequestInfo {
	id: number;
	version: number;
	state?: string;
	title: string;
	description: string;
	link?: string;
	source: PullRequestSide;
	target: PullRequestSide;
}

export interface InsightReportDataField {
	title: string;
	type?:
		| "BOOLEAN"
		| "DATE"
		| "DURATION"
		| "LINK"
		| "NUMBER"
		| "PERCENTAGE"
		| "TEXT";
	value: boolean | number | string | { href: string; linktext: string };
}

export interface InsightReportPayload {
	title: string;
	details?: string;
	result: "PASS" | "FAIL";
	reporter: string;
	link?: string;
	data?: InsightReportDataField[];
}

export interface InsightAnnotationPayload {
	externalId: string;
	path?: string;
	line?: number;
	message: string;
	severity: Severity;
	type?: AnnotationType;
	link?: string;
}

export interface RawBitbucketInsightAnnotation {
	externalId?: string;
	path?: string;
	line?: number;
	message?: string;
	severity?: Severity;
	type?: AnnotationType;
	link?: string;
}

export interface PullRequestComment {
	id: number;
	text: string;
	version: number;
	createdDate?: number;
	updatedDate?: number;
}

export interface RawBitbucketCodeInsightsReport {
	title?: string;
	details?: string;
	result?: "PASS" | "FAIL";
	reporter?: string;
	link?: string;
	data?: InsightReportDataField[];
}

export interface RawBitbucketPagedResponse<T> {
	values?: T[];
	isLastPage?: boolean;
	nextPageStart?: number;
}

export interface RawBitbucketAnnotationsResponse {
	totalCount?: number;
	annotations?: RawBitbucketInsightAnnotation[];
	values?: RawBitbucketInsightAnnotation[];
	isLastPage?: boolean;
	nextPageStart?: number;
}

export interface RawBitbucketCommentActivity {
	action?: string;
	createdDate?: number;
	comment?: {
		id: number;
		text?: string | null;
		version: number;
		createdDate?: number;
		updatedDate?: number;
	};
}

export type { AnnotationType, Severity };
