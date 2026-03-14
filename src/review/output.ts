import type { Logger } from "../shared/logger.ts";
import type { ReviewRunOutput } from "./output-types.ts";

export function printFindings(result: ReviewRunOutput, logger: Logger): void {
	logger.info(`PR #${result.context.prId}: ${result.context.title}`);
	logger.info(
		`Branches: ${result.context.sourceBranch} -> ${result.context.targetBranch}`,
	);
	logger.info(
		`Reviewed files: ${result.context.reviewedFiles}, skipped files: ${result.context.skippedFiles}`,
	);

	if (result.skipped) {
		logger.info(result.skipReason ?? "Review skipped.");
		return;
	}

	logger.info(result.review.summary);

	if (result.review.findings.length === 0) {
		logger.info("No reportable findings.");
		return;
	}

	for (const finding of result.review.findings) {
		logger.info(
			`- [${finding.severity}/${finding.confidence}] ${finding.path}:${finding.line} ${finding.title}`,
		);
	}
}
