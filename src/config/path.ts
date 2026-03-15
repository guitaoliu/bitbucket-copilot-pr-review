export type ConfigPath = readonly string[];
export type ConfigPathInput = string | ConfigPath;

function isConfigObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitConfigPath(path: string): ConfigPath {
	return path.split(".");
}

function toConfigPath(path: ConfigPathInput): ConfigPath {
	return typeof path === "string" ? splitConfigPath(path) : path;
}

export function cloneConfigValue<T>(value: T): T {
	if (Array.isArray(value)) {
		return [...value] as T;
	}

	return value;
}

export function getConfigPathValue(
	source: unknown,
	path: ConfigPathInput,
): unknown {
	let current = source;

	for (const segment of toConfigPath(path)) {
		if (!isConfigObject(current) || !(segment in current)) {
			return undefined;
		}

		current = current[segment];
	}

	return cloneConfigValue(current);
}

function getOrCreateConfigObject(
	target: Record<string, unknown>,
	segment: string,
): Record<string, unknown> {
	const existing = target[segment];
	if (isConfigObject(existing)) {
		return existing;
	}

	const next: Record<string, unknown> = {};
	target[segment] = next;
	return next;
}

export function setConfigPathValue(
	target: object,
	path: ConfigPathInput,
	value: unknown,
): void {
	const pathSegments = toConfigPath(path);
	let current = target as Record<string, unknown>;

	for (const segment of pathSegments.slice(0, -1)) {
		current = getOrCreateConfigObject(current, segment);
	}

	const leaf = pathSegments[pathSegments.length - 1];
	if (leaf !== undefined) {
		current[leaf] = cloneConfigValue(value);
	}
}
