import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { ReviewerConfig } from "../config/types.ts";
import { omitUndefined } from "../shared/object.ts";

interface HttpResponseData {
	statusCode: number;
	statusMessage: string;
	body: string;
}

export class BitbucketApiError extends Error {
	public readonly statusCode: number;
	public readonly statusMessage: string;
	public readonly method: string;
	public readonly url: string;
	public readonly responseBody: string;

	constructor(
		statusCode: number,
		statusMessage: string,
		method: string,
		url: string,
		responseBody: string,
	) {
		super(
			`Bitbucket request failed: ${method} ${url} -> ${statusCode} ${statusMessage}\n${responseBody}`,
		);
		this.name = "BitbucketApiError";
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.method = method;
		this.url = url;
		this.responseBody = responseBody;
	}
}

export class BitbucketTransport {
	private caCertPromise?: Promise<string | undefined>;
	private readonly config: ReviewerConfig["bitbucket"];

	constructor(config: ReviewerConfig["bitbucket"]) {
		this.config = config;
	}

	private buildUrl(pathname: string): string {
		return new URL(pathname, `${this.config.baseUrl}/`).toString();
	}

	private buildHeaders(hasJsonBody: boolean): Headers {
		const headers = new Headers({ Accept: "application/json;charset=UTF-8" });

		if (hasJsonBody) {
			headers.set("Content-Type", "application/json");
		}

		if (this.config.auth.type === "bearer") {
			headers.set("Authorization", `Bearer ${this.config.auth.token}`);
		} else {
			const encoded = Buffer.from(
				`${this.config.auth.username}:${this.config.auth.password}`,
				"utf8",
			).toString("base64");
			headers.set("Authorization", `Basic ${encoded}`);
		}

		return headers;
	}

	private async loadCaCertificate(): Promise<string | undefined> {
		if (!this.caCertPromise) {
			this.caCertPromise = this.config.tls.caCertPath
				? readFile(this.config.tls.caCertPath, "utf8")
				: Promise.resolve(undefined);
		}

		return this.caCertPromise;
	}

	private toHeaderRecord(headers: Headers): Record<string, string> {
		const result: Record<string, string> = {};
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}

	private formatNetworkError(
		method: string,
		url: string,
		error: unknown,
	): string {
		const currentError =
			error instanceof Error ? error : new Error(String(error));
		const currentErrorWithCode = currentError as Error & {
			code?: string;
			cause?: unknown;
		};
		const cause =
			currentErrorWithCode.cause instanceof Error
				? currentErrorWithCode.cause
				: undefined;
		const errorCode =
			currentErrorWithCode.code ??
			(cause as (Error & { code?: string }) | undefined)?.code;
		const detailMessage = cause?.message ?? currentError.message;

		const lines = [
			`Bitbucket network request failed: ${method} ${url}`,
			detailMessage,
		];

		if (
			errorCode &&
			[
				"CERT_HAS_EXPIRED",
				"DEPTH_ZERO_SELF_SIGNED_CERT",
				"ERR_TLS_CERT_ALTNAME_INVALID",
				"SELF_SIGNED_CERT_IN_CHAIN",
				"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
				"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			].includes(errorCode)
		) {
			lines.push(
				"Hint: this looks like a TLS certificate trust problem. Set BITBUCKET_CA_CERT_PATH to your corporate CA PEM file, or set BITBUCKET_INSECURE_TLS=0 to require strict TLS verification once trust is configured.",
			);
		}

		if (
			errorCode === "ECONNREFUSED" ||
			errorCode === "ENOTFOUND" ||
			errorCode === "EHOSTUNREACH"
		) {
			lines.push(
				"Hint: verify the Bitbucket URL you passed to the CLI, VPN connectivity, and whether the Bitbucket host is reachable from this machine.",
			);
		}

		return lines.join("\n");
	}

	private async sendRequest(
		url: URL,
		method: string,
		headers: Record<string, string>,
		body?: string,
	): Promise<HttpResponseData> {
		const requestModule = url.protocol === "https:" ? https : http;
		const ca =
			url.protocol === "https:" ? await this.loadCaCertificate() : undefined;

		const requestOptions = omitUndefined({
			method,
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port ? Number.parseInt(url.port, 10) : undefined,
			path: `${url.pathname}${url.search}`,
			headers,
			rejectUnauthorized:
				url.protocol === "https:"
					? !this.config.tls.insecureSkipVerify
					: undefined,
			ca,
		});

		return new Promise<HttpResponseData>((resolve, reject) => {
			const request = requestModule.request(requestOptions, (response) => {
				const chunks: Buffer[] = [];

				response.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});

				response.on("end", () => {
					resolve({
						statusCode: response.statusCode ?? 0,
						statusMessage: response.statusMessage ?? "",
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			});

			request.setTimeout(30000, () => {
				request.destroy(
					new Error(
						`Timed out after 30000ms while contacting ${url.toString()}`,
					),
				);
			});

			request.on("error", (error) => {
				reject(error);
			});

			if (body !== undefined) {
				request.write(body);
			}

			request.end();
		});
	}

	async request(pathname: string, init?: RequestInit): Promise<string> {
		const url = new URL(this.buildUrl(pathname));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : undefined;
		const headers = this.toHeaderRecord(this.buildHeaders(body !== undefined));

		try {
			const response = await this.sendRequest(url, method, headers, body);

			if (response.statusCode >= 200 && response.statusCode < 300) {
				return response.body;
			}

			throw new BitbucketApiError(
				response.statusCode,
				response.statusMessage,
				method,
				url.toString(),
				response.body,
			);
		} catch (error) {
			if (error instanceof BitbucketApiError) {
				throw error;
			}

			throw new Error(this.formatNetworkError(method, url.toString(), error), {
				cause: error instanceof Error ? error : undefined,
			});
		}
	}

	async requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
		const responseText = await this.request(pathname, init);
		return JSON.parse(responseText) as T;
	}
}
