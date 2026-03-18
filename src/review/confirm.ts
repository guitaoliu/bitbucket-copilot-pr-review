import process from "node:process";
import { createInterface } from "node:readline/promises";

export async function confirmRerun(options: {
	message: string;
}): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(
			"review --confirm-rerun requires an interactive terminal (TTY) so you can answer the prompt.",
		);
	}

	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = await readline.question(
			`${options.message}\nRerun review anyway? [y/N] `,
		);
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		readline.close();
	}
}
