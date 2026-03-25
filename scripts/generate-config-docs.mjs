import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { buildConfigReferenceMarkdown } = await import("../src/config/docs.ts");

const docsPath = path.resolve(process.cwd(), "docs", "operations.md");
const docs = await readFile(docsPath, "utf8");

const startMarker = "<!-- GENERATED_CONFIG_REFERENCE:START -->";
const endMarker = "<!-- GENERATED_CONFIG_REFERENCE:END -->";
const generatedBlock = `${startMarker}\n${buildConfigReferenceMarkdown()}\n${endMarker}`;

const nextDocs =
	docs.includes(startMarker) && docs.includes(endMarker)
		? docs.replace(
				new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
				generatedBlock,
			)
		: `${docs.trimEnd()}\n\n${generatedBlock}\n`;

await writeFile(docsPath, nextDocs, "utf8");
