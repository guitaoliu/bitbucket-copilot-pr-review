export function compressLineRanges(
	lines: number[],
): Array<{ start: number; end: number }> {
	if (lines.length === 0) {
		return [];
	}

	const uniqueLines = [...new Set(lines)].sort((left, right) => left - right);
	const ranges: Array<{ start: number; end: number }> = [];
	let start = uniqueLines[0] ?? 0;
	let end = uniqueLines[0] ?? 0;

	for (let index = 1; index < uniqueLines.length; index += 1) {
		const current = uniqueLines[index];
		if (current === undefined) {
			continue;
		}

		if (current === end + 1) {
			end = current;
			continue;
		}

		ranges.push({ start, end });
		start = current;
		end = current;
	}

	ranges.push({ start, end });
	return ranges;
}

export function formatLineRanges(lines: number[]): string {
	return compressLineRanges(lines)
		.map((range) =>
			range.start === range.end
				? `${range.start}`
				: `${range.start}-${range.end}`,
		)
		.join(", ");
}
