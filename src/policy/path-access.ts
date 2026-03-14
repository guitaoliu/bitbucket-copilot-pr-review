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

const SECRET_PATH_PATTERNS = [/\.env($|\.)/i];

type RepoDirectoryAccessDecision =
	| { include: true; normalizedPath: string }
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
): string | undefined {
	const segments = normalizedPath.split("/");

	if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
		return "generated or vendored path";
	}

	if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
		return "potential secret-bearing path";
	}

	return undefined;
}

export function getRepoDirectoryAccessDecision(
	directoryPath: string | undefined,
): RepoDirectoryAccessDecision {
	if (
		directoryPath === undefined ||
		directoryPath.trim() === "" ||
		directoryPath.trim() === "."
	) {
		return allow({ normalizedPath: "" });
	}

	const normalizedPath = normalizeRepoRelativePath(directoryPath);
	if (!normalizedPath) {
		return reject(
			"directory must be repo-relative and stay within the repository",
		);
	}

	const pathReason = getBasePathRejectionReason(normalizedPath);
	if (pathReason) {
		return reject(pathReason);
	}

	return allow({ normalizedPath });
}

export function getRepoFileAccessDecision(
	filePath: string,
): RepoFileAccessDecision {
	const normalizedPath = normalizeRepoRelativePath(filePath);
	if (!normalizedPath) {
		return reject("path must be repo-relative and stay within the repository");
	}

	const pathReason = getBasePathRejectionReason(normalizedPath);
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
