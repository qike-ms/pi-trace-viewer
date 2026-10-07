import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeViewerController, getViewerController, type ViewerController } from "../src/server.ts";

async function occupyPort(preferredPort = 0): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer();
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(preferredPort, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

interface HttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

async function httpRequest(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const req = request(url, { headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			response.on("end", () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.on("error", reject);
		req.end();
	});
}

async function startViewer(): Promise<ViewerController> {
	const reservation = await occupyPort(0);
	const port = reservation.port;
	await reservation.close();
	return getViewerController(port);
}

function accessToken(controller: ViewerController): string {
	const accessUrl = new URL(controller.accessUrl());
	const token = new URLSearchParams(accessUrl.hash.slice(1)).get("access");
	expect(accessUrl.pathname).toBe("/");
	expect(accessUrl.searchParams.has("access_token")).toBe(false);
	expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
	return token!;
}

function authHeaders(controller: ViewerController): Record<string, string> {
	return { "X-Pi-Trace-Token": accessToken(controller) };
}

describe("local viewer server", () => {
	afterEach(async () => {
		await closeViewerController();
	});

	it("increments port when startPort is in use (EADDRINUSE)", async () => {
		const occupied = await occupyPort(0);
		try {
			const controller = await getViewerController(occupied.port);
			expect(controller.port).toBe(occupied.port + 1);
			expect(controller.url).toBe(`http://127.0.0.1:${occupied.port + 1}`);
		} finally {
			await occupied.close();
		}
	});

	it("skips multiple consecutive occupied ports", async () => {
		const first = await occupyPort(0);
		let second: { close: () => Promise<void> } | undefined;
		try {
			second = await occupyPort(first.port + 1);
			const controller = await getViewerController(first.port);
			expect(controller.port).toBe(first.port + 2);
		} finally {
			await second?.close();
			await first.close();
		}
	});

	it("requires authentication for API routes without putting the token in the request URL", async () => {
		const controller = await startViewer();
		expect((await httpRequest(`${controller.url}/api/sessions`)).status).toBe(401);
		expect((await httpRequest(`${controller.url}/`)).status).toBe(200);

		expect((await httpRequest(`${controller.url}/api/sessions`, authHeaders(controller))).status).toBe(200);
		expect((await httpRequest(`${controller.url}/api/sessions?access_token=${accessToken(controller)}`)).status).toBe(200);
	});

	it("rejects unexpected Host and Origin headers", async () => {
		const controller = await startViewer();
		const headers = authHeaders(controller);
		expect((await httpRequest(`${controller.url}/api/sessions`, {
			...headers,
			Host: `evil.example:${controller.port}`,
		})).status).toBe(403);
		expect((await httpRequest(`${controller.url}/api/sessions`, {
			...headers,
			Origin: "http://evil.example",
		})).status).toBe(403);
	});

	it("returns 400 for malformed URL encoding without stopping the server", async () => {
		const controller = await startViewer();
		const headers = authHeaders(controller);
		expect((await httpRequest(`${controller.url}/api/sessions/%ZZ`, headers)).status).toBe(400);
		expect((await httpRequest(`${controller.url}/api/sessions`, headers)).status).toBe(200);
	});

	it("fails when the port range up to 65535 is exhausted", async () => {
		let occupied65535: { close: () => Promise<void> } | undefined;
		try {
			occupied65535 = await occupyPort(65535);
		} catch {
			// If 65535 cannot be bound in the current test environment (e.g. system restriction), skip
			return;
		}

		try {
			await expect(getViewerController(65535)).rejects.toThrow(
				"Could not find an available port from 65535 to 65535",
			);
		} finally {
			await occupied65535.close();
		}
	});
});
