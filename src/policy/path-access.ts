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

type RepoFileAccessDecision =
	| { include: true; normalizedPath: string }
	| { include: false; reason: string };

function hasExtensionIn(
	filePath: string,
	extensions: ReadonlySet<string>,
): boolean {
	const lowerPath = filePath.toLowerCase();
	return [...extensions].some((extension) => lowerPath.endsWith(extension));
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
		return !hasExtensionIn(lowerFilename, SOURCE_CODE_EXTENSIONS);
	}

	return hasExtensionIn(lowerFilename, SECRET_EXTENSIONS);
}

export function normalizeRepoPath(value: string): string | undefined {
	const trimmed = value.trim();
	if (
		trimmed.length === 0 ||
		trimmed.startsWith("/") ||
		trimmed.startsWith(":") ||
		/^[A-Za-z]:/.test(trimmed) ||
		trimmed.includes("\\") ||
		[...trimmed].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		return undefined;
	}

	const normalized = path.posix.normalize(trimmed);
	if (normalized === ".." || normalized.startsWith("../")) {
		return undefined;
	}

	return normalized;
}

export const REPO_SEARCH_EXCLUDE_GLOBS: readonly string[] = [
	...EXCLUDED_DIRECTORIES,
].map((directory) => `**/${directory}/**`);

export function matchesRepoPathPattern(
	filePath: string,
	pattern: string,
): boolean {
	const normalizedPattern = pattern.replace(/\/+$/, "");
	return (
		normalizedPattern === "." ||
		filePath === normalizedPattern ||
		filePath.startsWith(`${normalizedPattern}/`) ||
		path.posix.matchesGlob(filePath, normalizedPattern)
	);
}

function getRejectionReason(normalizedPath: string): string | undefined {
	const segments = normalizedPath.split("/");
	const filename = segments.at(-1) ?? normalizedPath;
	const directorySegments = segments.slice(0, -1);

	if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
		return "generated or vendored path";
	}

	if (
		SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath)) ||
		directorySegments.some((segment) =>
			isSecretBearingDirectorySegment(segment),
		) ||
		isSecretConfigDirectoryPath(directorySegments) ||
		isSecretBearingFilename(filename)
	) {
		return "potential secret-bearing path";
	}

	if (EXCLUDED_FILENAMES.has(filename)) {
		return "lockfile";
	}

	if (hasExtensionIn(normalizedPath, EXCLUDED_EXTENSIONS)) {
		return "binary or generated extension";
	}

	return undefined;
}

export function getRepoFileAccessDecision(
	filePath: string,
): RepoFileAccessDecision {
	const normalizedPath = normalizeRepoPath(filePath);
	if (!normalizedPath || normalizedPath === ".") {
		return {
			include: false,
			reason: "path must be repo-relative and stay within the repository",
		};
	}

	const reason = getRejectionReason(normalizedPath);
	return reason
		? { include: false, reason }
		: { include: true, normalizedPath };
}
