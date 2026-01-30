/**
 * Bun Worker Runner
 *
 * Executes Lambda handlers in isolated Bun Workers.
 * Provides hot-reload by replacing workers when code changes.
 *
 * Each lambda gets its own worker that can be replaced on file change
 * without affecting other lambdas.
 */

import { join } from "path";
import { existsSync } from "fs";
import type {
	InvokeRequest,
	InvokeResponse,
	LambdaResponse,
} from "./appsync-client";
import { getOriginalLambdaName, getLambdaBundleName } from "./naming";

// Worker message types
interface WorkerRequest {
	type: "invoke";
	requestId: string;
	event: unknown;
	context: unknown;
}

interface WorkerResponse {
	type: "result" | "error" | "console";
	requestId: string;
	result?: LambdaResponse;
	error?: {
		message: string;
		stack?: string;
	};
	// Console log fields
	level?: "log" | "warn" | "error" | "info" | "debug";
	args?: unknown[];
}

interface LambdaWorker {
	worker: Worker;
	lambdaName: string;
	bundlePath: string;
	workerUrl: string; // Store blob URL for cleanup
	pendingRequests: Map<
		string,
		{
			resolve: (response: InvokeResponse) => void;
			reject: (error: Error) => void;
			startTime: number;
			timeoutId: ReturnType<typeof setTimeout>;
		}
	>;
}

export interface WorkerRunnerConfig {
	outputDir: string;
	appName: string;
	onLog?: (lambdaName: string, message: string) => void;
	onError?: (lambdaName: string, error: Error) => void;
	onConsole?: (
		lambdaName: string,
		requestId: string,
		level: "log" | "warn" | "error" | "info" | "debug",
		args: unknown[],
	) => void;
}

/**
 * Worker Runner manages a pool of Bun Workers for executing Lambda handlers
 */
export class WorkerRunner {
	private config: WorkerRunnerConfig;
	private workers: Map<string, LambdaWorker> = new Map();
	private workerScript: string;

	constructor(config: WorkerRunnerConfig) {
		this.config = config;
		// The worker script that loads and executes lambda handlers
		this.workerScript = this.createWorkerScript();
	}

	/**
	 * Generate the worker script code
	 */
	private createWorkerScript(): string {
		return `
// Worker script for executing Lambda handlers
let handler = null;
let handlerPath = "";
let currentRequestId = null;
let currentLambdaName = "";

// ANSI colors
const dim = "\\x1b[90m";
const reset = "\\x1b[0m";
const yellow = "\\x1b[33m";
const red = "\\x1b[31m";

// Format timestamp to match Signale's format: [12:17:13 AM]
function formatTime() {
	const now = new Date();
	let h = now.getHours();
	const m = now.getMinutes().toString().padStart(2, "0");
	const s = now.getSeconds().toString().padStart(2, "0");
	const ampm = h >= 12 ? "PM" : "AM";
	h = h % 12;
	h = h ? h : 12; // 0 should be 12
	return "[" + h + ":" + m + ":" + s + " " + ampm + "]";
}

// Format log output to match Signale's scoped output style
function formatLog(level, args) {
	const time = formatTime();
	const name = currentLambdaName || "worker";
	const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
	
	// Match Signale's format: [HH:MM:SS AM] [scope] › symbol message
	let symbol = dim + "│" + reset;
	if (level === "warn") {
		symbol = yellow + "⚠" + reset;
	} else if (level === "error") {
		symbol = red + "✖" + reset;
	}
	
	return dim + time + reset + " [" + name + "] › " + symbol + "  " + msg;
}

// Override console methods to format output consistently
const originalConsole = {
	log: console.log.bind(console),
	warn: console.warn.bind(console),
	error: console.error.bind(console),
	info: console.info.bind(console),
	debug: console.debug.bind(console),
};

console.log = function(...args) {
	if (currentRequestId) {
		originalConsole.log(formatLog("log", args));
	} else {
		originalConsole.log(...args);
	}
};
console.warn = function(...args) {
	if (currentRequestId) {
		originalConsole.warn(formatLog("warn", args));
	} else {
		originalConsole.warn(...args);
	}
};
console.error = function(...args) {
	if (currentRequestId) {
		originalConsole.error(formatLog("error", args));
	} else {
		originalConsole.error(...args);
	}
};
console.info = function(...args) {
	if (currentRequestId) {
		originalConsole.log(formatLog("info", args));
	} else {
		originalConsole.info(...args);
	}
};
console.debug = function(...args) {
	if (currentRequestId) {
		originalConsole.log(formatLog("debug", args));
	} else {
		originalConsole.debug(...args);
	}
};

self.onmessage = async (event) => {
	const message = event.data;

	if (message.type === "load") {
		try {
			handlerPath = message.path;
			// Dynamic import the handler module
			const module = await import(handlerPath);
			handler = module.handler || module.default?.handler || module.default;
			
			if (typeof handler !== "function") {
				throw new Error("No handler function exported from module");
			}
			
			self.postMessage({ type: "loaded", success: true });
		} catch (err) {
			self.postMessage({
				type: "loaded",
				success: false,
				error: { message: err.message, stack: err.stack }
			});
		}
		return;
	}

	if (message.type === "invoke") {
		if (!handler) {
			self.postMessage({
				type: "error",
				requestId: message.requestId,
				error: { message: "Handler not loaded" }
			});
			return;
		}

		// Set current request context for console formatting
		currentRequestId = message.requestId;
		currentLambdaName = message.displayName || "lambda";

		try {
			const result = await handler(message.event, message.context);
			self.postMessage({
				type: "result",
				requestId: message.requestId,
				result
			});
		} catch (err) {
			self.postMessage({
				type: "error",
				requestId: message.requestId,
				error: { message: err.message, stack: err.stack }
			});
		} finally {
			// Clear request context after invocation
			currentRequestId = null;
			currentLambdaName = "";
		}
		return;
	}
};
`;
	}

	/**
	 * Get the bundle path for a lambda
	 */
	private getBundlePath(lambdaName: string): string {
		// lambdaName could be either "hello" or "cms-api-hello"
		// Extract the base name first, then construct the full bundle name
		const baseName = getOriginalLambdaName(this.config.appName, lambdaName);
		const bundleName = getLambdaBundleName(this.config.appName, baseName);
		return join(this.config.outputDir, `${bundleName}.js`);
	}

	/**
	 * Create a worker for a lambda
	 */
	private async createWorker(lambdaName: string): Promise<LambdaWorker> {
		const bundlePath = this.getBundlePath(lambdaName);

		if (!existsSync(bundlePath)) {
			throw new Error(`Bundle not found: ${bundlePath}`);
		}

		// Create a Blob URL for the worker script
		const blob = new Blob([this.workerScript], {
			type: "application/javascript",
		});
		const workerUrl = URL.createObjectURL(blob);

		const worker = new Worker(workerUrl, {
			type: "module",
		});

		const lambdaWorker: LambdaWorker = {
			worker,
			lambdaName,
			bundlePath,
			workerUrl,
			pendingRequests: new Map(),
		};

		// Set up message handler
		worker.onmessage = (event) => {
			this.handleWorkerMessage(lambdaWorker, event.data);
		};

		worker.onerror = (error) => {
			this.config.onError?.(lambdaName, new Error(error.message));
		};

		// Load the handler
		await this.loadHandler(lambdaWorker);

		return lambdaWorker;
	}

	/**
	 * Load the handler in a worker
	 */
	private loadHandler(lambdaWorker: LambdaWorker): Promise<void> {
		return new Promise((resolve, reject) => {
			const handleLoad = (event: MessageEvent) => {
				const message = event.data;
				if (message.type === "loaded") {
					lambdaWorker.worker.removeEventListener("message", handleLoad);
					if (message.success) {
						resolve();
					} else {
						reject(
							new Error(message.error?.message || "Failed to load handler"),
						);
					}
				}
			};

			lambdaWorker.worker.addEventListener("message", handleLoad);

			lambdaWorker.worker.postMessage({
				type: "load",
				path: lambdaWorker.bundlePath,
			});

			// Timeout for loading
			setTimeout(() => {
				lambdaWorker.worker.removeEventListener("message", handleLoad);
				reject(new Error("Handler load timeout"));
			}, 10000);
		});
	}

	/**
	 * Handle messages from worker
	 */
	private handleWorkerMessage(
		lambdaWorker: LambdaWorker,
		message: WorkerResponse,
	): void {
		// Note: Console messages are now handled directly by the worker via stdout
		// We only handle result/error messages here
		
		if (message.type === "result" || message.type === "error") {
			const pending = lambdaWorker.pendingRequests.get(message.requestId);
			if (pending) {
				// Clear the timeout to prevent memory leaks
				clearTimeout(pending.timeoutId);
				lambdaWorker.pendingRequests.delete(message.requestId);
				const duration = Date.now() - pending.startTime;

				if (message.type === "result") {
					pending.resolve({
						requestId: message.requestId,
						response: message.result,
						timestamp: Date.now(),
					});
				} else {
					pending.resolve({
						requestId: message.requestId,
						error: message.error,
						timestamp: Date.now(),
					});
				}

				this.config.onLog?.(
					lambdaWorker.lambdaName,
					`Executed in ${duration}ms`,
				);
			}
		}
	}

	/**
	 * Get or create a worker for a lambda
	 */
	private async getWorker(lambdaName: string): Promise<LambdaWorker> {
		let lambdaWorker = this.workers.get(lambdaName);

		if (!lambdaWorker) {
			lambdaWorker = await this.createWorker(lambdaName);
			this.workers.set(lambdaName, lambdaWorker);
		}

		return lambdaWorker;
	}

	/**
	 * Invoke a lambda handler
	 */
	async invoke(request: InvokeRequest): Promise<InvokeResponse> {
		const lambdaWorker = await this.getWorker(request.lambdaName);
		
		// Get display name (strip app prefix)
		const displayName = getOriginalLambdaName(this.config.appName, request.lambdaName);

		return new Promise((resolve, reject) => {
			// Timeout handling (15 minutes max like Lambda)
			const timeoutId = setTimeout(
				() => {
					const pending = lambdaWorker.pendingRequests.get(request.requestId);
					if (pending) {
						lambdaWorker.pendingRequests.delete(request.requestId);
						pending.resolve({
							requestId: request.requestId,
							error: { message: "Handler execution timeout" },
							timestamp: Date.now(),
						});
					}
				},
				15 * 60 * 1000,
			);

			// Add to pending requests with timeout reference
			lambdaWorker.pendingRequests.set(request.requestId, {
				resolve,
				reject,
				startTime: Date.now(),
				timeoutId,
			});

			// Send invoke message to worker
			lambdaWorker.worker.postMessage({
				type: "invoke",
				requestId: request.requestId,
				displayName,
				event: request.event,
				context: request.context,
			});
		});
	}

	/**
	 * Reload a lambda worker (after code changes)
	 */
	async reloadLambda(lambdaName: string): Promise<void> {
		const existing = this.workers.get(lambdaName);

		if (existing) {
			// Terminate old worker
			existing.worker.terminate();
			// Revoke blob URL to prevent memory leaks
			URL.revokeObjectURL(existing.workerUrl);

			// Clear timeouts and reject pending requests
			for (const [requestId, pending] of existing.pendingRequests) {
				clearTimeout(pending.timeoutId);
				pending.reject(new Error("Worker reloaded"));
			}

			this.workers.delete(lambdaName);
		}

		// Create new worker (will be created on next invoke)
		// Optionally pre-warm:
		await this.getWorker(lambdaName);
	}

	/**
	 * Reload all workers
	 */
	async reloadAll(): Promise<void> {
		const lambdaNames = Array.from(this.workers.keys());

		for (const lambdaName of lambdaNames) {
			await this.reloadLambda(lambdaName);
		}
	}

	/**
	 * Remove a lambda worker
	 */
	removeLambda(lambdaName: string): void {
		const existing = this.workers.get(lambdaName);

		if (existing) {
			existing.worker.terminate();
			// Revoke blob URL to prevent memory leaks
			URL.revokeObjectURL(existing.workerUrl);

			for (const pending of existing.pendingRequests.values()) {
				clearTimeout(pending.timeoutId);
				pending.reject(new Error("Worker removed"));
			}

			this.workers.delete(lambdaName);
		}
	}

	/**
	 * Terminate all workers
	 */
	terminate(): void {
		for (const [lambdaName, lambdaWorker] of this.workers) {
			lambdaWorker.worker.terminate();
			// Revoke blob URL to prevent memory leaks
			URL.revokeObjectURL(lambdaWorker.workerUrl);

			for (const pending of lambdaWorker.pendingRequests.values()) {
				clearTimeout(pending.timeoutId);
				pending.reject(new Error("Runner terminated"));
			}
		}

		this.workers.clear();
	}

	/**
	 * Get list of active lambda names
	 */
	getActiveLambdas(): string[] {
		return Array.from(this.workers.keys());
	}
}

/**
 * Create a worker runner instance
 */
export function createWorkerRunner(config: WorkerRunnerConfig): WorkerRunner {
	return new WorkerRunner(config);
}
