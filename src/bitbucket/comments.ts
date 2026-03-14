import type { PullRequestCommentStrategy } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import type {
	PullRequestComment,
	RawBitbucketCommentActivity,
	RawBitbucketPagedResponse,
} from "./types.ts";

function validatePullRequestCommentText(text: string): void {
	if (text.trim().length === 0) {
		throw new Error("Pull request comment text must not be empty.");
	}

	if (text.length > BITBUCKET_PR_COMMENT_MAX_CHARS) {
		throw new Error(
			`Pull request comment text exceeds the local Bitbucket safety limit of ${BITBUCKET_PR_COMMENT_MAX_CHARS} characters (${text.length}).`,
		);
	}
}

function getCommentSortTimestamp(
	comment: Pick<PullRequestComment, "createdDate" | "updatedDate">,
): number {
	return comment.updatedDate ?? comment.createdDate ?? 0;
}

function comparePullRequestComments(
	left: PullRequestComment,
	right: PullRequestComment,
): number {
	const timestampDifference =
		getCommentSortTimestamp(right) - getCommentSortTimestamp(left);
	if (timestampDifference !== 0) {
		return timestampDifference;
	}

	const versionDifference = right.version - left.version;
	if (versionDifference !== 0) {
		return versionDifference;
	}

	return right.id - left.id;
}

export class PullRequestCommentsApi {
	private readonly projectKey: string;
	private readonly repoSlug: string;
	private readonly prId: number;
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
		prId: number,
		logger: Logger,
		request: (pathname: string, init?: RequestInit) => Promise<string>,
		requestJson: <T>(pathname: string, init?: RequestInit) => Promise<T>,
	) {
		this.projectKey = projectKey;
		this.repoSlug = repoSlug;
		this.prId = prId;
		this.logger = logger;
		this.request = request;
		this.requestJson = requestJson;
	}

	async listPullRequestComments(): Promise<PullRequestComment[]> {
		const commentsById = new Map<number, PullRequestComment>();
		let start = 0;

		while (true) {
			const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}/activities?limit=1000&start=${start}`;
			const payload =
				await this.requestJson<
					RawBitbucketPagedResponse<RawBitbucketCommentActivity>
				>(pathname);

			for (const activity of payload.values ?? []) {
				if (activity.action !== "COMMENTED" || !activity.comment) {
					continue;
				}

				const nextComment = omitUndefined({
					id: activity.comment.id,
					text: activity.comment.text ?? "",
					version: activity.comment.version,
					createdDate: activity.comment.createdDate ?? activity.createdDate,
					updatedDate:
						activity.comment.updatedDate ??
						activity.comment.createdDate ??
						activity.createdDate,
				}) satisfies PullRequestComment;
				const existing = commentsById.get(nextComment.id);
				if (
					!existing ||
					existing.version < nextComment.version ||
					(existing.version === nextComment.version &&
						getCommentSortTimestamp(existing) <
							getCommentSortTimestamp(nextComment))
				) {
					commentsById.set(nextComment.id, nextComment);
				}
			}

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				break;
			}

			start = payload.nextPageStart;
		}

		return [...commentsById.values()];
	}

	private async listPullRequestCommentsByTag(
		tag: string,
	): Promise<PullRequestComment[]> {
		const marker = `<!-- ${tag} -->`;
		const comments = await this.listPullRequestComments();
		return comments
			.filter((comment) => comment.text.includes(marker))
			.sort(comparePullRequestComments);
	}

	async findPullRequestCommentByTag(
		tag: string,
	): Promise<PullRequestComment | undefined> {
		return (await this.listPullRequestCommentsByTag(tag))[0];
	}

	async createPullRequestComment(text: string): Promise<void> {
		validatePullRequestCommentText(text);
		const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}/comments`;
		await this.request(pathname, {
			method: "POST",
			body: JSON.stringify({ text }),
		});
	}

	async updatePullRequestComment(
		commentId: number,
		version: number,
		text: string,
	): Promise<void> {
		validatePullRequestCommentText(text);
		const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}/comments/${commentId}`;
		await this.request(pathname, {
			method: "PUT",
			body: JSON.stringify({ version, text }),
		});
	}

	async deletePullRequestComment(
		commentId: number,
		version: number,
	): Promise<void> {
		const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}/comments/${commentId}?version=${encodeURIComponent(String(version))}`;
		await this.request(pathname, {
			method: "DELETE",
		});
	}

	async upsertPullRequestComment(
		tag: string,
		text: string,
		options: {
			strategy?: PullRequestCommentStrategy;
		} = {},
	): Promise<void> {
		const strategy = options.strategy ?? "update";
		const existingComments = await this.listPullRequestCommentsByTag(tag);
		const existing = existingComments[0];

		if (!existing) {
			this.logger.info(`Creating pull request summary comment tagged ${tag}`);
			await this.createPullRequestComment(text);
			return;
		}

		if (strategy === "recreate") {
			this.logger.info(
				`Creating replacement pull request summary comment tagged ${tag}`,
			);
			await this.createPullRequestComment(text);

			for (const comment of existingComments) {
				try {
					this.logger.info(
						`Deleting superseded pull request summary comment ${comment.id} tagged ${tag}`,
					);
					await this.deletePullRequestComment(comment.id, comment.version);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.logger.warn(
						`Failed to delete superseded pull request summary comment ${comment.id} tagged ${tag}: ${message}`,
					);
				}
			}
			return;
		}

		this.logger.info(`Updating pull request summary comment tagged ${tag}`);
		await this.updatePullRequestComment(existing.id, existing.version, text);
	}
}
