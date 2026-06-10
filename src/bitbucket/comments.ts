import type { PullRequestCommentStrategy } from "../config/types.ts";
import type { ReviewFinding } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import { BitbucketApiError } from "./transport.ts";
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

const SUPERSEDED_PULL_REQUEST_COMMENT_TEXT =
	"_Superseded by a newer automated PR review summary. This thread is preserved because Bitbucket will not delete it._";
const SUPERSEDED_FINDING_COMMENT_TEXT =
	"_Superseded by a newer automated PR review finding. This thread is preserved because Bitbucket will not delete it._";

interface PullRequestCommentAnchor {
	diffType: "EFFECTIVE";
	path: string;
	line: number;
	lineType: "ADDED";
	fileType: "TO";
}

interface FindingCommentMetadata {
	revision: string;
	reviewedCommit: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isCommentDeletionBlockedByReplies(
	error: unknown,
): error is BitbucketApiError {
	if (!(error instanceof BitbucketApiError) || error.statusCode !== 409) {
		return false;
	}

	const detail = `${error.responseBody}\n${error.message}`;
	return (
		detail.includes("CommentDeletionException") ||
		/replies which must be deleted first/i.test(detail)
	);
}

function isCommentDeletionBlockedByResolvedThread(
	error: unknown,
): error is BitbucketApiError {
	if (!(error instanceof BitbucketApiError) || error.statusCode !== 400) {
		return false;
	}

	const detail = `${error.responseBody}\n${error.message}`;
	return /cannot be deleted from resolved thread/i.test(detail);
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFindingCommentMarker(tag: string, externalId: string): string {
	return `<!-- ${tag}:finding:${externalId} -->`;
}

function parseFindingCommentExternalId(
	tag: string,
	text: string,
): string | undefined {
	const match = new RegExp(
		`<!--\\s*${escapeRegexLiteral(tag)}:finding:([^>\\s]+)\\s*-->`,
	).exec(text);
	return match?.[1];
}

function buildFindingCommentText(
	tag: string,
	finding: ReviewFinding,
	metadata: FindingCommentMetadata,
): string {
	const location =
		finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
	const lines = [
		buildFindingCommentMarker(tag, finding.externalId),
		`<!-- ${tag}:finding-revision:${metadata.revision} -->`,
		`<!-- ${tag}:finding-reviewed-commit:${metadata.reviewedCommit} -->`,
		`**Type:** ${finding.type} | **Severity:** ${finding.severity} | **Confidence:** ${finding.confidence}`,
		"",
		`**${finding.title}**`,
		"",
		`Location: \`${location}\``,
	];

	if (finding.details.trim().length > 0) {
		lines.push("", finding.details);
	}

	return lines.join("\n");
}

function buildFindingCommentAnchor(
	finding: ReviewFinding,
): PullRequestCommentAnchor | undefined {
	if (finding.line <= 0) {
		return undefined;
	}

	return {
		diffType: "EFFECTIVE",
		path: finding.path,
		line: finding.line,
		lineType: "ADDED",
		fileType: "TO",
	};
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

	async createPullRequestComment(
		text: string,
		options: { anchor?: PullRequestCommentAnchor } = {},
	): Promise<void> {
		validatePullRequestCommentText(text);
		const pathname = `/rest/api/latest/projects/${encodeURIComponent(this.projectKey)}/repos/${encodeURIComponent(this.repoSlug)}/pull-requests/${this.prId}/comments`;
		await this.request(pathname, {
			method: "POST",
			body: JSON.stringify(omitUndefined({ text, anchor: options.anchor })),
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
					const deleteBlockedByReplies =
						isCommentDeletionBlockedByReplies(error);
					const deleteBlockedByResolvedThread =
						isCommentDeletionBlockedByResolvedThread(error);

					if (deleteBlockedByResolvedThread) {
						this.logger.debug(
							`Superseded pull request summary comment ${comment.id} tagged ${tag} is in a resolved thread and cannot be deleted or archived; leaving it in place.`,
						);
						continue;
					}

					if (deleteBlockedByReplies) {
						try {
							this.logger.info(
								`Superseded pull request summary comment ${comment.id} tagged ${tag} has replies; archiving it instead of deleting`,
							);
							await this.updatePullRequestComment(
								comment.id,
								comment.version,
								SUPERSEDED_PULL_REQUEST_COMMENT_TEXT,
							);
							continue;
						} catch (archiveError) {
							this.logger.warn(
								`Failed to archive superseded pull request summary comment ${comment.id} tagged ${tag} after delete was blocked by replies: ${getErrorMessage(archiveError)}`,
							);
							continue;
						}
					}

					this.logger.warn(
						`Failed to delete superseded pull request summary comment ${comment.id} tagged ${tag}: ${getErrorMessage(error)}`,
					);
				}
			}
			return;
		}

		this.logger.info(`Updating pull request summary comment tagged ${tag}`);
		await this.updatePullRequestComment(existing.id, existing.version, text);
	}

	private async deleteOrArchiveFindingComment(
		comment: Pick<PullRequestComment, "id" | "version">,
		tag: string,
	): Promise<void> {
		try {
			this.logger.info(
				`Deleting stale pull request finding comment ${comment.id} tagged ${tag}`,
			);
			await this.deletePullRequestComment(comment.id, comment.version);
		} catch (error) {
			const deleteBlockedByReplies = isCommentDeletionBlockedByReplies(error);
			const deleteBlockedByResolvedThread =
				isCommentDeletionBlockedByResolvedThread(error);

			if (deleteBlockedByResolvedThread) {
				this.logger.debug(
					`Stale pull request finding comment ${comment.id} tagged ${tag} is in a resolved thread and cannot be deleted or archived; leaving it in place.`,
				);
				return;
			}

			if (deleteBlockedByReplies) {
				try {
					this.logger.info(
						`Stale pull request finding comment ${comment.id} tagged ${tag} has replies; archiving it instead of deleting`,
					);
					await this.updatePullRequestComment(
						comment.id,
						comment.version,
						SUPERSEDED_FINDING_COMMENT_TEXT,
					);
					return;
				} catch (archiveError) {
					this.logger.warn(
						`Failed to archive stale pull request finding comment ${comment.id} tagged ${tag} after delete was blocked by replies: ${getErrorMessage(archiveError)}`,
					);
					return;
				}
			}

			this.logger.warn(
				`Failed to delete stale pull request finding comment ${comment.id} tagged ${tag}: ${getErrorMessage(error)}`,
			);
		}
	}

	private async listPullRequestFindingCommentsByExternalId(
		tag: string,
	): Promise<Map<string, PullRequestComment>> {
		const comments = await this.listPullRequestComments();
		const commentsByExternalId = new Map<string, PullRequestComment>();

		for (const comment of comments.sort(comparePullRequestComments)) {
			const externalId = parseFindingCommentExternalId(tag, comment.text);
			if (!externalId) {
				continue;
			}

			const existing = commentsByExternalId.get(externalId);
			if (existing) {
				await this.deleteOrArchiveFindingComment(comment, tag);
				continue;
			}

			commentsByExternalId.set(externalId, comment);
		}

		return commentsByExternalId;
	}

	async reconcilePullRequestFindingComments(
		tag: string,
		findings: ReviewFinding[],
		metadata: FindingCommentMetadata,
	): Promise<void> {
		const existingByExternalId =
			await this.listPullRequestFindingCommentsByExternalId(tag);
		const desiredExternalIds = new Set(
			findings.map((finding) => finding.externalId),
		);

		for (const finding of findings) {
			const text = buildFindingCommentText(tag, finding, metadata);
			const existing = existingByExternalId.get(finding.externalId);
			if (existing) {
				await this.updatePullRequestComment(
					existing.id,
					existing.version,
					text,
				);
				continue;
			}

			const anchor = buildFindingCommentAnchor(finding);
			await this.createPullRequestComment(text, anchor ? { anchor } : {});
		}

		for (const [externalId, comment] of existingByExternalId) {
			if (desiredExternalIds.has(externalId)) {
				continue;
			}

			await this.deleteOrArchiveFindingComment(comment, tag);
		}
	}
}
