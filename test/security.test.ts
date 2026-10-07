import { describe, expect, it } from "vitest";
import { redactHeaders, redactSensitive } from "../src/security.ts";

describe("redaction", () => {
	it("redacts credential-shaped keys without removing observable content", () => {
		const input = {
			api_key: "secret",
			"x-goog-api-key": "secret-2",
			anthropicApiKey: "secret-3",
			content: "keep this prompt",
			nested: { accessToken: "secret-4", signingCredential: "secret-5", model: "gpt" },
		};
		expect(redactSensitive(input)).toEqual({
			api_key: "[REDACTED]",
			"x-goog-api-key": "[REDACTED]",
			anthropicApiKey: "[REDACTED]",
			content: "keep this prompt",
			nested: { accessToken: "[REDACTED]", signingCredential: "[REDACTED]", model: "gpt" },
		});
	});

	it("redacts sensitive response headers case-insensitively", () => {
		expect(redactHeaders({ "Set-Cookie": "private", "x-request-id": "req-1" })).toEqual({
			"Set-Cookie": "[REDACTED]",
			"x-request-id": "req-1",
		});
	});

	it("handles circular payloads", () => {
		const input: Record<string, unknown> = {};
		input.self = input;
		expect(redactSensitive(input)).toEqual({ self: "[Circular]" });
	});
});
