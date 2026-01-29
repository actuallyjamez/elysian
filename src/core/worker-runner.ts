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
	type: "result" | "error";
	requestId: string;
	result?: LambdaResponse;
	error?: {
		message: string;
		stack?: string;
	};
}

interface LambdaWorker {
	worker: Worker;
	lambdaName: string;
	bundlePath: string;
	pendingRequests: Map<
		string,
		{
			resolve: (response: InvokeResponse) => void;
			reject: (error: Error) => void;
			startTime: number;
		}
	>;
}

export interface WorkerRunnerConfig {
	outputDir: string;
	appName: string;
	onLog?: (lambdaName: string, message: string) => void;
	onError?: (lambdaName: string, error: Error) => void;
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
	 * Create the worker script that will be used to execute handlers
	 */
	private createWorkerScript(): string {
		return `
// Worker script for executing Lambda handlers
let handler = null;
let handlerPath = "";

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
		if (message.type === "result" || message.type === "error") {
			const pending = lambdaWorker.pendingRequests.get(message.requestId);
			if (pending) {
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

		return new Promise((resolve, reject) => {
			// Add to pending requests
			lambdaWorker.pendingRequests.set(request.requestId, {
				resolve,
				reject,
				startTime: Date.now(),
			});

			// Send invoke message to worker
			lambdaWorker.worker.postMessage({
				type: "invoke",
				requestId: request.requestId,
				event: request.event,
				context: request.context,
			});

			// Timeout handling (15 minutes max like Lambda)
			setTimeout(
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

			// Reject pending requests
			for (const [requestId, pending] of existing.pendingRequests) {
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

			for (const pending of existing.pendingRequests.values()) {
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

			for (const pending of lambdaWorker.pendingRequests.values()) {
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
