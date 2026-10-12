import { omitUndefined } from "../shared/object.ts";
import type { BitbucketRepoScope } from "./scope.ts";
import type {
	PullRequestInfo,
	PullRequestSide,
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
	private readonly scope: BitbucketRepoScope;

	constructor(scope: BitbucketRepoScope) {
		this.scope = scope;
	}

	async getPullRequest(): Promise<PullRequestInfo> {
		const payload =
			await this.scope.transport.requestJson<RawBitbucketPullRequest>(
				this.scope.pullRequestPath,
			);
		return normalizePullRequest(payload);
	}
}
