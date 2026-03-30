import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".next",
	".pnpm-store",
	".yarn",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
	"target",
	"vendor",
]);

const EXCLUDED_FILENAMES = new Set([
	".npmrc",
	".pypirc",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"gradle.lockfile",
	"go.sum",
	"uv.lock",
]);

const EXCLUDED_EXTENSIONS = new Set([
	".bmp",
	".class",
	".dll",
	".dylib",
	".exe",
	".gif",
	".ico",
	".jar",
	".key",
	".jpeg",
	".jpg",
	".lock",
	".min.css",
	".min.js",
	".pdf",
	".pem",
	".png",
	".p12",
	".pfx",
	".so",
	".svg",
	".ttf",
	".woff",
	".woff2",
	".zip",
]);

const SECRET_PATH_PATTERNS = [
	/\.env($|\.)/i,
	/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys)(?:$|\.)/i,
	/(^|\/)(?:\.aws\/credentials|\.docker\/config\.json)(?:$|\/)/i,
];

const SECRET_BASENAME_PATTERNS = [
	/^credentials?$/i,
	/^secrets?$/i,
	/^tokens?$/i,
	/^passwd$/i,
	/^htpasswd$/i,
	/^auth(?:entication|orization)?[._-](?:token|tokens|secret|secrets|key|keys|config|credentials?)$/i,
	/^private[-_.]?key$/i,
	/^signing[-_.]?key$/i,
	/^deploy[-_.]?key$/i,
	/^service[-_.]?account$/i,
	/^serviceaccount$/i,
];

const SECRET_DIRECTORY_SEGMENT_PATTERNS = [
	/^secrets?$/i,
	/^private[-_.]?key$/i,
	/^signing[-_.]?key$/i,
	/^deploy[-_.]?key$/i,
	/^service[-_.]?account$/i,
	/^serviceaccount$/i,
];

const SECRET_CONFIG_DIRECTORY_PREFIX_PATTERNS = [
	/^config$/i,
	/^configs$/i,
	/^conf$/i,
	/^etc$/i,
	/^infra$/i,
	/^ops$/i,
	/^deploy(?:ment)?$/i,
];

const SECRET_CONFIG_DIRECTORY_NAME_PATTERNS = [/^credentials?$/i, /^tokens?$/i];

const SOURCE_CODE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cs",
	".cts",
	".go",
	".h",
	".hpp",
	".java",
	".js",
	".jsx",
	".kt",
	".kts",
	".mjs",
	".mts",
	".php",
	".py",
	".rb",
	".rs",
	".scala",
	".sh",
	".sql",
	".svelte",
	".swift",
	".ts",
	".tsx",
	".vue",
	".zsh",
]);

const SECRET_EXTENSIONS = new Set([
	".asc",
	".crt",
	".der",
	".jks",
	".kdb",
	".keystore",
	".keytab",
	".kubeconfig",
	".ovpn",
	".pkcs12",
	".pub",
	".p8",
	".rsa",
	".secret",
]);

type RepoDirectoryAccessDecision =
	| { include: true; normalizedPath: string }
	| { include: false; reason: string };

type RepoDirectoriesAccessDecision =
	| { include: true; normalizedPaths: string[] }
	| { include: false; reason: string };

type RepoFileAccessDecision =
	| { include: true; normalizedPath: string }
	| { include: false; reason: string };

function hasExcludedExtension(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	for (const extension of EXCLUDED_EXTENSIONS) {
		if (lowerPath.endsWith(extension)) {
			return true;
		}
	}
	return false;
}

function hasSecretExtension(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	for (const extension of SECRET_EXTENSIONS) {
		if (lowerPath.endsWith(extension)) {
			return true;
		}
	}

	return false;
}

function hasSourceCodeExtension(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	for (const extension of SOURCE_CODE_EXTENSIONS) {
		if (lowerPath.endsWith(extension)) {
			return true;
		}
	}

	return false;
}

function getFilenameStem(filename: string): string {
	const parsed = path.posix.parse(filename);
	return parsed.ext ? parsed.name : parsed.base;
}

function isSecretBearingDirectorySegment(segment: string): boolean {
	if (segment.length === 0) {
		return false;
	}

	const lowerSegment = segment.toLowerCase();
	return SECRET_DIRECTORY_SEGMENT_PATTERNS.some((pattern) =>
		pattern.test(lowerSegment),
	);
}

function isSecretConfigDirectoryPath(segments: string[]): boolean {
	for (let index = 1; index < segments.length; index += 1) {
		const segment = segments[index]?.toLowerCase() ?? "";
		if (
			!SECRET_CONFIG_DIRECTORY_NAME_PATTERNS.some((pattern) =>
				pattern.test(segment),
			)
		) {
			continue;
		}

		const parentSegment = segments[index - 1]?.toLowerCase() ?? "";
		if (
			SECRET_CONFIG_DIRECTORY_PREFIX_PATTERNS.some((pattern) =>
				pattern.test(parentSegment),
			)
		) {
			return true;
		}
	}

	return false;
}

function isSecretBearingFilename(filename: string): boolean {
	if (filename.length === 0) {
		return false;
	}

	const lowerFilename = filename.toLowerCase();
	const stem = getFilenameStem(lowerFilename);
	if (SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(stem))) {
		if (hasSourceCodeExtension(lowerFilename)) {
			return false;
		}

		return true;
	}

	return hasSecretExtension(lowerFilename);
}

function reject(reason: string): { include: false; reason: string } {
	return { include: false, reason };
}

function allow<T extends object>(value: T): T & { include: true } {
	return { include: true, ...value };
}

export function normalizeRepoRelativePath(
	filePath: string,
): string | undefined {
	const trimmed = filePath.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
	if (normalized === "." || normalized === "") {
		return undefined;
	}

	if (
		normalized.startsWith("/") ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return undefined;
	}

	return normalized;
}

function getBasePathRejectionReason(
	normalizedPath: string,
	pathKind: "file" | "directory",
): string | undefined {
	const segments = normalizedPath.split("/");
	const filename = segments[segments.length - 1] ?? normalizedPath;
	const directorySegments =
		pathKind === "directory" ? segments : segments.slice(0, -1);

	if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
		return "generated or vendored path";
	}

	if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
		return "potential secret-bearing path";
	}

	if (
		directorySegments.some((segment) =>
			isSecretBearingDirectorySegment(segment),
		)
	) {
		return "potential secret-bearing path";
	}

	if (isSecretConfigDirectoryPath(directorySegments)) {
		return "potential secret-bearing path";
	}

	if (pathKind === "file" && isSecretBearingFilename(filename)) {
		return "potential secret-bearing path";
	}

	return undefined;
}

function collapseNestedDirectoryPaths(paths: string[]): string[] {
	let collapsed: string[] = [];

	for (const normalizedPath of paths) {
		if (
			collapsed.some(
				(existingPath) =>
					existingPath === normalizedPath ||
					normalizedPath.startsWith(`${existingPath}/`),
			)
		) {
			continue;
		}

		collapsed = collapsed.filter(
			(existingPath) => !existingPath.startsWith(`${normalizedPath}/`),
		);
		collapsed.push(normalizedPath);
	}

	return collapsed;
}

export function getRepoDirectoriesAccessDecision(
	directoryPaths: string[] | undefined,
): RepoDirectoriesAccessDecision {
	if (!directoryPaths || directoryPaths.length === 0) {
		return allow({ normalizedPaths: [] });
	}

	let repoRootRequested = false;
	const normalizedPaths: string[] = [];

	for (const directoryPath of directoryPaths) {
		const trimmed = directoryPath.trim();
		if (trimmed === "" || trimmed === ".") {
			repoRootRequested = true;
			continue;
		}

		const normalizedPath = normalizeRepoRelativePath(trimmed);
		if (!normalizedPath) {
			return reject(
				"directory must be repo-relative and stay within the repository",
			);
		}

		if (
			normalizedPath.includes("*") ||
			normalizedPath.includes("?") ||
			normalizedPath.includes("[")
		) {
			return reject(
				"directory wildcards are not supported; pass concrete repo-relative directories as a directories array",
			);
		}

		const pathReason = getBasePathRejectionReason(normalizedPath, "directory");
		if (pathReason) {
			return reject(pathReason);
		}

		normalizedPaths.push(normalizedPath);
	}

	if (repoRootRequested) {
		return allow({ normalizedPaths: [] });
	}

	return allow({
		normalizedPaths: collapseNestedDirectoryPaths(normalizedPaths),
	});
}

export function getRepoDirectoryAccessDecision(
	directoryPath: string | undefined,
): RepoDirectoryAccessDecision {
	const decision = getRepoDirectoriesAccessDecision(
		directoryPath === undefined ? undefined : [directoryPath],
	);
	if (!decision.include) {
		return decision;
	}

	return allow({ normalizedPath: decision.normalizedPaths[0] ?? "" });
}

export function getRepoFileAccessDecision(
	filePath: string,
): RepoFileAccessDecision {
	const normalizedPath = normalizeRepoRelativePath(filePath);
	if (!normalizedPath) {
		return reject("path must be repo-relative and stay within the repository");
	}

	const pathReason = getBasePathRejectionReason(normalizedPath, "file");
	if (pathReason) {
		return reject(pathReason);
	}

	const segments = normalizedPath.split("/");
	const filename = segments[segments.length - 1] ?? normalizedPath;

	if (EXCLUDED_FILENAMES.has(filename)) {
		return reject("lockfile");
	}

	if (hasExcludedExtension(normalizedPath)) {
		return reject("binary or generated extension");
	}

	return allow({ normalizedPath });
}
