import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { CallView, SessionSnapshot, TracePersistence, TraceRecord } from "./types.ts";
import { TRACE_SCHEMA_VERSION } from "./types.ts";

export interface TraceStoreOptions {
	persist?: boolean;
	maxBytes?: number;
}

const DEFAULT_MAX_TRACE_BYTES = 64 * 1024 * 1024;
const TRACE_IGNORE = "*\n!.gitignore\n";

export type TraceListener = (record: TraceRecord) => void;
type TraceRecordInput = TraceRecord extends infer RecordType
	? RecordType extends TraceRecord
		? Omit<RecordType, "schemaVersion" | "sessionId" | "sequence" | "timestamp"> & { timestamp?: string }
		: never
	: never;

export class TraceStore {
	readonly sessionId: string;
	filePath: string | undefined;
	private records: TraceRecord[] = [];
	private sequence = 0;
	private listeners = new Set<TraceListener>();
	private persistence: TracePersistence;
	private maxBytes: number;

	constructor(snapshot: SessionSnapshot, options: TraceStoreOptions = {}) {
		this.sessionId = snapshot.id;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_TRACE_BYTES;
		if (options.persist) {
			const prepared = prepareTraceFile(snapshot.cwd, snapshot.id, this.maxBytes);
			this.filePath = prepared.filePath;
			this.persistence = prepared.filePath
				? { status: "persisted", filePath: prepared.filePath }
				: { status: "memory_only", error: prepared.error };
		} else {
			this.filePath = undefined;
			this.persistence = { status: "memory_only", error: "Persistence is disabled by default" };
		}
		try {
			this.load();
		} catch (error) {
			this.persistence = {
				status: "memory_only",
				error: error instanceof Error ? error.message : String(error),
			};
			this.filePath = undefined;
		}
		if (!this.records.some((record) => record.type === "trace_header")) {
			this.append({ type: "trace_header", sessionFile: snapshot.file, cwd: snapshot.cwd });
		}
		this.reconcileHistoricalCompactions(snapshot);
	}

	onRecord(listener: TraceListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	append(record: TraceRecordInput): TraceRecord {
		const complete = {
			...record,
			schemaVersion: TRACE_SCHEMA_VERSION,
			sessionId: this.sessionId,
			sequence: ++this.sequence,
			timestamp: record.timestamp ?? new Date().toISOString(),
		} as TraceRecord;
		this.records.push(complete);
		if (this.filePath) {
			try {
				this.appendToFile(`${JSON.stringify(complete)}\n`);
			} catch (error) {
				this.persistence = {
					status: "memory_only",
					error: error instanceof Error ? error.message : String(error),
				};
				this.filePath = undefined;
			}
		}
		for (const listener of this.listeners) listener(complete);
		return complete;
	}

	private appendToFile(content: string): void {
		if (!this.filePath) return;
		const fd = openSync(
			this.filePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) throw new Error("Trace path is not a regular file");
			if (stat.size + Buffer.byteLength(content) > this.maxBytes) {
				throw new Error(`Trace reached the ${this.maxBytes}-byte persistence limit`);
			}
			writeSync(fd, content, undefined, "utf8");
			fchmodSync(fd, 0o600);
		} finally {
			closeSync(fd);
		}
	}

	getPersistence(): TracePersistence {
		return { ...this.persistence };
	}

	getRecords(): readonly TraceRecord[] {
		return this.records;
	}

	getCalls(): CallView[] {
		const calls = new Map<string, CallView>();
		for (const record of this.records) {
			if (!("callId" in record)) continue;
			if (record.type === "call_started") {
				calls.set(record.callId, {
					callId: record.callId,
					kind: record.kind,
					startedAt: record.timestamp,
					turnIndex: record.turnIndex,
					leafId: record.leafId,
					model: record.model,
					captureSource: record.captureSource ?? "live",
					sourceEntryId: record.sourceEntryId,
					status: "running",
					providerRequests: [],
					providerResponses: [],
					outputEvents: [],
				});
				continue;
			}
			const call = calls.get(record.callId);
			if (!call) continue;
			switch (record.type) {
				case "generic_context":
					call.context = record.context;
					break;
				case "compaction_context":
					call.compactionContext = record.context;
					break;
				case "provider_request":
					call.providerRequests.push({ attempt: record.attempt, timestamp: record.timestamp, payload: record.payload });
					break;
				case "provider_response":
					call.providerResponses.push({
						attempt: record.attempt,
						timestamp: record.timestamp,
						status: record.status,
						headers: record.headers,
					});
					break;
				case "output_event":
					call.outputEvents.push({ timestamp: record.timestamp, event: record.event });
					break;
				case "call_completed":
					call.status = "success";
					call.completedAt = record.timestamp;
					call.finalMessage = record.message;
					call.leafId = record.leafId ?? call.leafId;
					break;
				case "call_failed":
					call.status = "error";
					call.completedAt = record.timestamp;
					call.error = record.error;
					break;
				case "compaction_completed":
					call.status = "success";
					call.completedAt = record.timestamp;
					call.finalMessage = { role: "assistant", content: [{ type: "text", text: record.summary }] };
					break;
				case "branch_summary_completed":
					call.status = "success";
					call.completedAt = record.timestamp;
					call.leafId = record.leafId ?? call.leafId;
					call.finalMessage = { role: "assistant", content: [{ type: "text", text: record.summary }] };
					break;
			}
		}
		return Array.from(calls.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	private load(): void {
		if (!this.filePath || !existsSync(this.filePath)) return;
		const fd = openSync(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) throw new Error("Trace path is not a regular file");
			if (stat.size > this.maxBytes) throw new Error(`Trace exceeds the ${this.maxBytes}-byte persistence limit`);
			const loaded: TraceRecord[] = [];
			for (const line of readFileSync(fd, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line) as TraceRecord;
					if (record.schemaVersion === TRACE_SCHEMA_VERSION && record.sessionId === this.sessionId) loaded.push(record);
				} catch {
					// A truncated final line is expected after an abrupt process exit.
				}
			}
			this.records = loaded;
			this.sequence = loaded.reduce((max, record) => Math.max(max, record.sequence), 0);
		} finally {
			closeSync(fd);
		}
	}

	private reconcileHistoricalCompactions(snapshot: SessionSnapshot): void {
		const completed = this.records.filter((record) => record.type === "compaction_completed");
		for (const entry of snapshot.entries) {
			if (entry.type !== "compaction") continue;
			const alreadyCaptured = completed.some(
				(record) =>
					record.sourceEntryId === entry.id ||
					(record.summary === entry.summary && record.tokensBefore === entry.tokensBefore),
			);
			if (alreadyCaptured) continue;
			const callId = `session-compaction-${entry.id}`;
			this.append({
				type: "call_started",
				callId,
				kind: "compaction",
				leafId: entry.parentId,
				captureSource: "session_entry",
				sourceEntryId: entry.id,
				timestamp: entry.timestamp,
			});
			this.append({
				type: "compaction_completed",
				callId,
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				sourceEntryId: entry.id,
				timestamp: entry.timestamp,
			});
		}
	}
}

function prepareTraceFile(cwd: string, sessionId: string, maxBytes: number): { filePath?: string; error?: string } {
	try {
		if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error("Session ID is not safe for trace persistence");
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Trace persistence limit must be positive");
		const resolvedCwd = realpathSync(cwd);
		const cwdStat = lstatSync(resolvedCwd);
		if (!cwdStat.isDirectory()) throw new Error(`Trace cwd is not a directory: ${cwd}`);

		const traceDirectory = join(resolvedCwd, ".pi-traces");
		if (existsSync(traceDirectory)) {
			const stat = lstatSync(traceDirectory);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Trace directory must be a real directory");
			assertOwner(stat.uid);
		} else {
			mkdirSync(traceDirectory, { mode: 0o700 });
		}
		chmodSync(traceDirectory, 0o700);
		writePrivateFile(join(traceDirectory, ".gitignore"), TRACE_IGNORE);

		const filePath = join(traceDirectory, `${sessionId}.jsonl`);
		if (existsSync(filePath)) {
			const stat = lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Trace path must be a regular file");
			assertOwner(stat.uid);
			if (stat.size > maxBytes) throw new Error(`Trace exceeds the ${maxBytes}-byte persistence limit`);
			chmodSync(filePath, 0o600);
		}
		return { filePath };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function writePrivateFile(path: string, content: string): void {
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Trace metadata path is not a regular file");
		writeSync(fd, content, undefined, "utf8");
		fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

function assertOwner(uid: number): void {
	if (typeof process.getuid === "function" && uid !== process.getuid()) {
		throw new Error("Trace storage is not owned by the current user");
	}
}
