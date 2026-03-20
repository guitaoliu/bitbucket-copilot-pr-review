export class CliUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUserError";
	}
}

export function isCliUserError(error: unknown): error is CliUserError {
	return error instanceof CliUserError;
}
