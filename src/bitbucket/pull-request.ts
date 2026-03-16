import { omitUndefined } from "../shared/object.ts";
import type {
	PullRequestInfo,
	PullRequestSide,
	RawBitbucketPagedResponse,
	RawBitbucketPullRequest,
	RawBitbucketRepository,
} from "./types.ts";

function selectCloneUrl(
	repository: RawBitbucketRepository,
): string | undefined {
	const cloneLinks = repository.links?.clone ?? [];
	return (
		cloneLinks.find((link) => (link.name ?? "").toLowerCase().includes("http"))
			?.href ?? cloneLinks[0]?.href
	);
}

function normalizePullRequest(
	payload: RawBitbucketPullRequest,
): PullRequestInfo {
	const sourceCloneUrl = selectCloneUrl(payload.fromRef.repository);
	const targetCloneUrl = selectCloneUrl(payload.toRef.repository);
	const selfLink = payload.links?.self?.[0]?.href;
	const source = omitUndefined({
		repositoryId: payload.fromRef.repository.id,
		projectKey: payload.fromRef.repository.project.key,
		repoSlug: payload.fromRef.repository.slug,
		cloneUrl: sourceCloneUrl,
		refId: payload.fromRef.id,
		displayId: payload.fromRef.displayId,
		latestCommit: payload.fromRef.latestCommit,
	}) satisfies PullRequestSide;
	const target = omitUndefined({
		repositoryId: payload.toRef.repository.id,
		projectKey: payload.toRef.repository.project.key,
		repoSlug: payload.toRef.repository.slug,
		cloneUrl: targetCloneUrl,
		refId: payload.toRef.id,
		displayId: payload.toRef.displayId,
		latestCommit: payload.toRef.latestCommit,
	}) satisfies PullRequestSide;

	return omitUndefined({
		id: payload.id,
		version: payload.version,
		state: payload.state,
		draft: payload.draft,
		title: payload.title,
		description: payload.description?.trim() || "",
		link: selfLink,
		source,
		target,
	}) satisfies PullRequestInfo;
}

export class PullRequestApi {
	private readonly projectKey: string;
	private readonly repoSlug: string;
	private readonly prId: number;
	private readonly requestJson: <T>(
		pathname: string,
		init?: RequestInit,
	) => Promise<T>;

	constructor(
		projectKey: string,
		repoSlug: string,
		prId: number,
		requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>,
	) {
		this.projectKey = projectKey;
		this.repoSlug = repoSlug;
		this.prId = prId;
		this.requestJson = requestJson;
	}

	async getPullRequest(): Promise<PullRequestInfo> {
		const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}`;
		const payload = await this.requestJson<RawBitbucketPullRequest>(pathname);
		return normalizePullRequest(payload);
	}
}

export class RepositoryPullRequestApi {
	private readonly projectKey: string;
	private readonly repoSlug: string;
	private readonly requestJson: <T>(
		pathname: string,
		init?: RequestInit,
	) => Promise<T>;

	constructor(
		projectKey: string,
		repoSlug: string,
		requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>,
	) {
		this.projectKey = projectKey;
		this.repoSlug = repoSlug;
		this.requestJson = requestJson;
	}

	async listPullRequests(state?: string): Promise<PullRequestInfo[]> {
		let start = 0;
		const pullRequests: PullRequestInfo[] = [];

		while (true) {
			const searchParams = new URLSearchParams({
				limit: "1000",
				start: String(start),
			});
			if (state !== undefined) {
				searchParams.set("state", state);
			}

			const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests?${searchParams.toString()}`;
			const payload =
				await this.requestJson<
					RawBitbucketPagedResponse<RawBitbucketPullRequest>
				>(pathname);

			for (const pullRequest of payload.values ?? []) {
				pullRequests.push(normalizePullRequest(pullRequest));
			}

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				return pullRequests;
			}

			start = payload.nextPageStart;
		}
	}

	async listOpenPullRequests(): Promise<PullRequestInfo[]> {
		return this.listPullRequests("OPEN");
	}
}
