import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const { getRepoReviewConfigSchema } = await import(
	"../src/config/repo-config.ts"
);

const outputPath = path.resolve(
	process.cwd(),
	"schemas",
	"copilot-code-review.schema.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });

const schema = {
	$id: "https://pmsplbbitbucket01.corporate.datacard.com:8443/projects/AAAS/repos/bitbucket-copilot-pr-review/raw/schemas/copilot-code-review.schema.json",
	...getRepoReviewConfigSchema(),
	title: "Copilot Code Review Config",
	description:
		"Trusted repository-level review configuration loaded from copilot-code-review.json at the pull request base commit.",
};

await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
