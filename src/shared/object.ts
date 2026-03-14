type KeysWithUndefined<T extends object> = {
	[K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

type KeysWithoutUndefined<T extends object> = Exclude<
	keyof T,
	KeysWithUndefined<T>
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type OmitUndefined<T extends object> = Simplify<
	{ [K in KeysWithoutUndefined<T>]: T[K] } & {
		[K in KeysWithUndefined<T>]?: Exclude<T[K], undefined>;
	}
>;

export function omitUndefined<const T extends Record<string, unknown>>(
	value: T,
): OmitUndefined<T> {
	const result: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}

	return result as OmitUndefined<T>;
}
