import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

export async function listenOnLoopback(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

export async function closeServer(server: Server): Promise<void> {
	server.close();
	await once(server, "close");
}

export async function readRequestBody(
	request: IncomingMessage,
): Promise<string> {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
	}
	return body;
}
