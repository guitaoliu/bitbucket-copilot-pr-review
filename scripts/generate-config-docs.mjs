import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { buildConfigReferenceMarkdown } = await import("../src/config/docs.ts");

const readmePath = path.resolve(process.cwd(), "README.md");
const readme = await readFile(readmePath, "utf8");

const startMarker = "<!-- GENERATED_CONFIG_REFERENCE:START -->";
const endMarker = "<!-- GENERATED_CONFIG_REFERENCE:END -->";
const generatedBlock = `${startMarker}\n${buildConfigReferenceMarkdown()}\n${endMarker}`;

const nextReadme =
	readme.includes(startMarker) && readme.includes(endMarker)
		? readme.replace(
				new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
				generatedBlock,
			)
		: `${readme.trimEnd()}\n\n${generatedBlock}\n`;

await writeFile(readmePath, nextReadme, "utf8");
