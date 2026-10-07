function isSensitiveKey(key: string): boolean {
	const normalized = key.replace(/[-_]/g, "").toLowerCase();
	return normalized === "authorization"
		|| normalized === "proxyauthorization"
		|| normalized === "cookie"
		|| normalized === "setcookie"
		|| normalized.endsWith("apikey")
		|| normalized.endsWith("token")
		|| normalized.endsWith("secret")
		|| normalized.endsWith("password")
		|| normalized.endsWith("credential")
		|| normalized.endsWith("privatekey");
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
	if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);

	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSensitive(item, seen);
	}
	return result;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key, isSensitiveKey(key) ? "[REDACTED]" : value]),
	);
}
