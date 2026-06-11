import { createHash } from "node:crypto";

import type { AnnotationType } from "./types.ts";

export function buildFindingThreadKey(input: {
	path: string;
	line: number;
	type: AnnotationType;
	collisionIndex?: number;
}): string {
	const collisionIndex = input.collisionIndex ?? 0;
	const digest = createHash("sha1")
		.update(
			[
				input.path,
				String(input.line),
				input.type,
				...(collisionIndex > 0 ? [String(collisionIndex)] : []),
			].join("|"),
		)
		.digest("hex");
	return `thread-${digest.slice(0, 16)}`;
}
