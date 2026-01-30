/**
 * Elysian CLI Logger
 *
 * Signale-based logging system for consistent, beautiful CLI output.
 * Uses Signale's interactive mode, timers, and scopes for a better UX.
 */

import { Signale, SignaleOptions } from "signale";
import { version } from "../core/version";

/**
 * Custom logger types for Elysian CLI
 */
const customTypes = {
	// Invocation lifecycle
	invoke: {
		badge: "\u25B6",
		color: "blue",
		label: "invoke",
		logLevel: "info",
	},
	response: {
		badge: "\u25C0",
		color: "green",
		label: "response",
		logLevel: "info",
	},
	// Build/Deploy
	build: {
		badge: "\u2692",
		color: "yellow",
		label: "build",
		logLevel: "info",
	},
	deploy: {
		badge: "\u2601",
		color: "cyan",
		label: "deploy",
		logLevel: "info",
	},
	// Lambda/Route
	lambda: {
		badge: "\u03BB",
		color: "magenta",
		label: "lambda",
		logLevel: "info",
	},
	route: {
		badge: "\u2192",
		color: "white",
		label: "route",
		logLevel: "info",
	},
	// Status
	watching: {
		badge: "\u25C9",
		color: "cyan",
		label: "watching",
		logLevel: "info",
	},
	reload: {
		badge: "\u21BB",
		color: "yellow",
		label: "reload",
		logLevel: "info",
	},
	// Standard overrides with better badges
	success: {
		badge: "\u2714",
		color: "green",
		label: "success",
		logLevel: "info",
	},
	error: {
		badge: "\u2716",
		color: "red",
		label: "error",
		logLevel: "error",
	},
	warn: {
		badge: "\u26A0",
		color: "yellow",
		label: "warn",
		logLevel: "warn",
	},
	info: {
		badge: "\u203A",
		color: "blue",
		label: "info",
		logLevel: "info",
	},
	debug: {
		badge: "\u2699",
		color: "gray",
		label: "debug",
		logLevel: "debug",
	},
	pending: {
		badge: "\u25CB",
		color: "magenta",
		label: "pending",
		logLevel: "info",
	},
	complete: {
		badge: "\u25CF",
		color: "green",
		label: "complete",
		logLevel: "info",
	},
	await: {
		badge: "\u2026",
		color: "cyan",
		label: "awaiting",
		logLevel: "info",
	},
	start: {
		badge: "\u25B6",
		color: "green",
		label: "start",
		logLevel: "info",
	},
	note: {
		badge: "\u2139",
		color: "blue",
		label: "note",
		logLevel: "info",
	},
	star: {
		badge: "\u2605",
		color: "yellow",
		label: "star",
		logLevel: "info",
	},
};

/**
 * Base Signale options for the Elysian logger
 */
const baseOptions: SignaleOptions = {
	types: customTypes,
	config: {
		displayScope: true,
		displayBadge: true,
		displayDate: false,
		displayFilename: false,
		displayLabel: false,
		displayTimestamp: true,
		underlineLabel: false,
		underlineMessage: false,
		uppercaseLabel: false,
	},
};

/**
 * Extended Signale interface with our custom types
 */
export interface ElysianLogger extends Signale {
	invoke: Signale["log"];
	response: Signale["log"];
	build: Signale["log"];
	deploy: Signale["log"];
	lambda: Signale["log"];
	route: Signale["log"];
	watching: Signale["log"];
	reload: Signale["log"];
	star: Signale["log"];
}

/**
 * Create the main logger instance
 */
function createLogger(): ElysianLogger {
	return new Signale(baseOptions) as ElysianLogger;
}

/**
 * Create an interactive logger for spinners/progress
 */
export function createInteractiveLogger(scope?: string): ElysianLogger {
	return new Signale({
		...baseOptions,
		interactive: true,
		scope,
	}) as ElysianLogger;
}

/**
 * Create a scoped logger
 */
export function createScopedLogger(scope: string): ElysianLogger {
	return new Signale({
		...baseOptions,
		scope,
	}) as ElysianLogger;
}

/**
 * Main logger instance
 */
export const logger = createLogger();

/**
 * Interactive logger for spinners (uses Signale's interactive mode)
 */
const interactiveLogger = createInteractiveLogger();

// ============================================
// Interactive Progress (replaces Spinner)
// ============================================

/**
 * Task runner using Signale interactive mode
 * Replaces the custom Spinner class with native Signale functionality
 */
export class Task {
	private message: string;
	private interactive: ElysianLogger;
	private startTime: number = 0;
	private timerLabel: string;

	constructor(message: string) {
		this.message = message;
		this.interactive = createInteractiveLogger();
		this.timerLabel = `task_${Date.now()}`;
	}

	start(): this {
		this.startTime = Date.now();
		this.interactive.await(this.message);
		return this;
	}

	update(message: string): this {
		this.message = message;
		this.interactive.await(message);
		return this;
	}

	succeed(message?: string): number {
		const duration = Date.now() - this.startTime;
		this.interactive.success(message || this.message);
		return duration;
	}

	fail(message?: string): number {
		const duration = Date.now() - this.startTime;
		this.interactive.error(message || this.message);
		return duration;
	}
}

/**
 * Create a new task (interactive progress indicator)
 */
export function createTask(message: string): Task {
	return new Task(message);
}

// Keep old name for backwards compatibility
export const createSpinner = createTask;
export const Spinner = Task;

// ============================================
// Trigger Detection & Invocation Logging
// ============================================

/**
 * Trigger types for function invocations
 */
export type TriggerType =
	| "HTTP"
	| "SQS"
	| "EventBridge"
	| "S3"
	| "DynamoDB"
	| "Schedule"
	| "Unknown";

/**
 * Invocation context for tracking function calls
 */
export interface InvocationContext {
	/** Full deployed lambda name (e.g., hello-world-process-queue) */
	lambdaName: string;
	/** Short display name for logging (e.g., process-queue) */
	displayName: string;
	requestId: string;
	trigger: TriggerType;
	triggerDetails?: string;
	method?: string;
	path?: string;
	queueName?: string;
	eventSource?: string;
	startTime: number;
}

/**
 * Detect the trigger type from the Lambda event
 */
export function detectTrigger(event: unknown): {
	trigger: TriggerType;
	details: string;
} {
	if (!event || typeof event !== "object") {
		return { trigger: "Unknown", details: "" };
	}

	const e = event as Record<string, unknown>;

	// HTTP API Gateway / ALB
	if (e.requestContext && (e.rawPath || e.path || e.httpMethod)) {
		const requestContext = e.requestContext as Record<string, unknown>;
		const httpContext = requestContext?.http as Record<string, unknown> | undefined;
		const method = ((e.httpMethod as string) || (httpContext?.method as string) || "?");
		const path = (e.rawPath || e.path || "/") as string;
		return {
			trigger: "HTTP",
			details: `${method.toUpperCase()} ${path}`,
		};
	}

	// SQS
	if (e.Records && Array.isArray(e.Records) && e.Records.length > 0) {
		const record = e.Records[0] as Record<string, unknown>;
		if (record.eventSource === "aws:sqs") {
			const arnParts = ((record.eventSourceARN as string) || "").split(":");
			const queueName = arnParts[arnParts.length - 1] || "unknown";
			const msgCount = e.Records.length;
			return {
				trigger: "SQS",
				details: msgCount > 1 ? `${queueName} (${msgCount})` : queueName,
			};
		}

		// S3
		if (record.eventSource === "aws:s3") {
			const s3Data = record.s3 as Record<string, unknown> | undefined;
			const bucketData = s3Data?.bucket as Record<string, unknown> | undefined;
			const bucket = (bucketData?.name as string) || "unknown";
			return {
				trigger: "S3",
				details: bucket,
			};
		}

		// DynamoDB Streams
		if (record.eventSource === "aws:dynamodb") {
			const count = e.Records.length;
			return {
				trigger: "DynamoDB",
				details: count > 1 ? `${count} records` : "1 record",
			};
		}
	}

	// Scheduled events (check before generic EventBridge)
	if (e.source === "aws.events" && e["detail-type"] === "Scheduled Event") {
		return {
			trigger: "Schedule",
			details: "",
		};
	}

	// EventBridge (other events)
	if (e["detail-type"] && e.source) {
		// Shorten common AWS sources
		let source = e.source as string;
		if (source.startsWith("aws.")) {
			source = source.slice(4); // Remove "aws." prefix
		}
		return {
			trigger: "EventBridge",
			details: source,
		};
	}

	return { trigger: "Unknown", details: "" };
}

/**
 * Color codes for HTTP methods
 */
const methodColors: Record<string, string> = {
	GET: "\x1b[32m", // green
	POST: "\x1b[34m", // blue
	PUT: "\x1b[33m", // yellow
	DELETE: "\x1b[31m", // red
	PATCH: "\x1b[35m", // magenta
	HEAD: "\x1b[36m", // cyan
	OPTIONS: "\x1b[90m", // gray
};

const resetColor = "\x1b[0m";
const dimColor = "\x1b[90m";
const boldColor = "\x1b[1m";
const cyanColor = "\x1b[36m";
const greenColor = "\x1b[32m";
const redColor = "\x1b[31m";
const yellowColor = "\x1b[33m";

/**
 * Colorize an HTTP method
 */
export function colorMethod(method: string): string {
	const color = methodColors[method.toUpperCase()] || "";
	return `${color}${method.toUpperCase()}${resetColor}`;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format bytes in human-readable format
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Invocation Logger
 *
 * Creates a scoped logger for tracking a single function invocation.
 * Console output from handlers goes directly to stdout via the worker.
 * This logger only handles invoke/complete messages.
 */
export class InvocationLogger {
	private ctx: InvocationContext;
	private scopedLogger: ElysianLogger;

	constructor(ctx: InvocationContext) {
		this.ctx = ctx;
		// Use Signale's scope feature for the lambda name
		this.scopedLogger = logger.scope(ctx.displayName) as ElysianLogger;
	}

	/**
	 * Log the start of an invocation
	 */
	start(): void {
		const { trigger, triggerDetails } = this.ctx;

		let triggerStr: string;
		if (trigger === "HTTP" && this.ctx.method && this.ctx.path) {
			triggerStr = `${colorMethod(this.ctx.method)} ${this.ctx.path}`;
		} else if (trigger === "SQS" && this.ctx.queueName) {
			triggerStr = `sqs ${this.ctx.queueName}`;
		} else if (trigger === "Schedule") {
			triggerStr = "scheduled";
		} else if (triggerDetails) {
			triggerStr = `${trigger.toLowerCase()} ${triggerDetails}`;
		} else {
			triggerStr = trigger.toLowerCase();
		}

		this.scopedLogger.invoke(triggerStr);
	}

	/**
	 * Log successful completion of the invocation
	 */
	complete(statusCode?: number): void {
		const duration = Date.now() - this.ctx.startTime;

		if (statusCode !== undefined) {
			const statusColor = statusCode >= 400 ? redColor : greenColor;
			this.scopedLogger.complete(`${statusColor}${statusCode}${resetColor} ${dimColor}${formatDuration(duration)}${resetColor}`);
		} else {
			this.scopedLogger.complete(`${dimColor}${formatDuration(duration)}${resetColor}`);
		}
	}

	/**
	 * Log failed completion of the invocation
	 */
	fail(error?: string | Error): void {
		const duration = Date.now() - this.ctx.startTime;

		const errorMsg = error 
			? (error instanceof Error ? error.message : error)
			: "Failed";

		this.scopedLogger.error(`${errorMsg} ${dimColor}${formatDuration(duration)}${resetColor}`);
	}

	/**
	 * Get the invocation context
	 */
	getContext(): InvocationContext {
		return this.ctx;
	}
}

/**
 * Extract the short display name from a full lambda name
 * e.g., "hello-world-process-queue" -> "process-queue" (removes app prefix)
 */
function getDisplayName(lambdaName: string, appName?: string): string {
	if (appName && lambdaName.startsWith(`${appName}-`)) {
		return lambdaName.slice(appName.length + 1);
	}
	return lambdaName;
}

/**
 * Create an invocation logger from a Lambda event
 */
export function createInvocationLogger(
	lambdaName: string,
	requestId: string,
	event: unknown,
	appName?: string,
): InvocationLogger {
	const { trigger, details } = detectTrigger(event);
	const e = event as Record<string, unknown>;

	const ctx: InvocationContext = {
		lambdaName,
		displayName: getDisplayName(lambdaName, appName),
		requestId,
		trigger,
		triggerDetails: details,
		startTime: Date.now(),
	};

	// Extract additional context based on trigger type
	if (trigger === "HTTP") {
		const requestContext = e.requestContext as Record<string, unknown> | undefined;
		const httpContext = requestContext?.http as Record<string, unknown> | undefined;
		ctx.method = (
			(e.httpMethod as string) ||
			(httpContext?.method as string) ||
			"?"
		);
		ctx.path = (e.rawPath || e.path || "/") as string;
	} else if (trigger === "SQS") {
		const records = e.Records as Array<Record<string, unknown>> | undefined;
		const firstRecord = records?.[0];
		const arnParts = (firstRecord?.eventSourceARN as string)?.split(":")?.pop();
		ctx.queueName = arnParts || undefined;
	}

	return new InvocationLogger(ctx);
}

/**
 * Active invocation loggers by request ID
 */
const activeInvocations = new Map<string, InvocationLogger>();

/**
 * Start tracking an invocation
 */
export function startInvocation(
	lambdaName: string,
	requestId: string,
	event: unknown,
	appName?: string,
): InvocationLogger {
	const invocationLogger = createInvocationLogger(lambdaName, requestId, event, appName);
	invocationLogger.start();
	activeInvocations.set(requestId, invocationLogger);
	return invocationLogger;
}

/**
 * Get an active invocation logger by request ID
 */
export function getInvocation(requestId: string): InvocationLogger | undefined {
	return activeInvocations.get(requestId);
}

/**
 * End an invocation and clean up
 */
export function endInvocation(
	requestId: string,
	statusCode?: number,
	error?: string | Error,
): void {
	const invocationLogger = activeInvocations.get(requestId);
	if (invocationLogger) {
		if (error) {
			invocationLogger.fail(error);
		} else {
			invocationLogger.complete(statusCode);
		}
		activeInvocations.delete(requestId);
	}
}

// ============================================
// CLI Output Helpers
// ============================================

/**
 * Print the Elysian header with version
 */
export function printHeader(mode?: string): void {
	console.log();
	console.log(
		`  ${boldColor}${cyanColor}elysian${resetColor} ${dimColor}v${version}${resetColor}${mode ? ` ${mode}` : ""}`,
	);
	console.log();
}

/**
 * Print a divider line
 */
export function printDivider(): void {
	console.log();
	console.log(`${dimColor}  ${"─".repeat(50)}${resetColor}`);
	console.log();
}

/**
 * Print a blank line
 */
export function printBlank(): void {
	console.log();
}

/**
 * Print a section header
 */
export function printSection(title: string): void {
	console.log();
	console.log(`  ${boldColor}${title}${resetColor}`);
	console.log();
}

/**
 * Print a key-value pair
 */
export function printKeyValue(
	key: string,
	value: string,
	indent: number = 1,
): void {
	console.log("  ".repeat(indent) + `${dimColor}${key}:${resetColor} ${value}`);
}

/**
 * Print a lambda label
 */
export function printLambda(label: string, suffix?: string): void {
	const suffixStr = suffix ? ` ${dimColor}(${suffix})${resetColor}` : "";
	console.log(`  ${dimColor}\u03BB${resetColor} ${boldColor}${label}${resetColor}${suffixStr}`);
}

/**
 * Print a route line with method coloring
 */
export function printRoute(
	method: string,
	path: string,
	params?: string[],
	maxPathLen?: number,
): void {
	const methodStr = colorMethod(method).padEnd(15); // Extra padding for ANSI codes
	const pathStr = maxPathLen ? path.padEnd(maxPathLen + 2) : path;
	const paramsStr =
		params && params.length > 0 ? ` ${dimColor}[${params.join(", ")}]${resetColor}` : "";
	console.log(`    ${methodStr} ${pathStr}${paramsStr}`);
}

/**
 * Print terraform outputs
 */
export function printOutputs(outputs: Record<string, unknown>): void {
	if (Object.keys(outputs).length === 0) return;

	printSection("Outputs");
	for (const [key, value] of Object.entries(outputs)) {
		const valueStr = typeof value === "string" ? value : JSON.stringify(value);
		console.log(`  ${dimColor}${key}:${resetColor} ${cyanColor}${valueStr}${resetColor}`);
	}
}

/**
 * Print build/deploy summary with timing
 */
export function printSummary(options: {
	lambdas: number;
	routes?: number;
	duration: number;
	action?: string;
}): void {
	const action = options.action || "Built";
	const routeStr =
		options.routes !== undefined ? ` (${options.routes} routes)` : "";
	logger.success(
		`${action} ${boldColor}${options.lambdas}${resetColor} lambda${options.lambdas === 1 ? "" : "s"}${routeStr} in ${boldColor}${formatDuration(options.duration)}${resetColor}`,
	);
}

/**
 * Print watch mode status box
 */
export function printWatchBox(options: {
	watching: string[];
	output: string;
	localstack?: boolean;
	apiEndpoint?: string;
	openapiEndpoint?: string;
}): void {
	printDivider();

	for (const dir of options.watching) {
		console.log(`  ${dimColor}Watching${resetColor}  ${dir}`);
	}
	console.log(`  ${dimColor}Output${resetColor}    ${options.output}`);
	if (options.localstack) {
		console.log(
			`  ${dimColor}Deploy${resetColor}    ${greenColor}LocalStack${resetColor} ${dimColor}(tflocal)${resetColor}`,
		);
	}

	if (options.apiEndpoint) {
		console.log();
		console.log(`  ${dimColor}\u279C${resetColor}  ${boldColor}API${resetColor}       ${cyanColor}${options.apiEndpoint}${resetColor}`);
		if (options.openapiEndpoint) {
			console.log(`  ${dimColor}\u279C${resetColor}  ${boldColor}OpenAPI${resetColor}   ${cyanColor}${options.openapiEndpoint}${resetColor}`);
		}
	}

	console.log();
	console.log(`  ${dimColor}Press Ctrl+C to stop${resetColor}`);
	console.log();
}

/**
 * Print the dev mode status screen
 */
export function printDevStatus(options: {
	duration: number;
	apiRoutes: Array<{
		lambda: string;
		routes: Array<{ method: string; path: string; pathParameters: string[] }>;
		size?: number;
	}>;
	functions: Array<{
		name: string;
		trigger?: { type: string; config?: Record<string, unknown> };
		size?: number;
	}>;
	apiEndpoint?: string;
	openapiEndpoint?: string;
	localstack?: boolean;
}): void {
	// Ready message
	logger.success(`Ready in ${boldColor}${formatDuration(options.duration)}${resetColor}`);

	// API Routes
	if (options.apiRoutes.length > 0) {
		printSection("API Routes");

		const maxPathLen = Math.max(
			...options.apiRoutes.flatMap((r) => r.routes.map((route) => route.path.length)),
			10,
		);

		for (const lambda of options.apiRoutes) {
			const sizeStr = lambda.size ? formatSize(lambda.size) : undefined;
			printLambda(lambda.lambda, sizeStr);

			for (const route of lambda.routes) {
				printRoute(route.method, route.path, route.pathParameters, maxPathLen);
			}
			printBlank();
		}
	}

	// Functions
	if (options.functions.length > 0) {
		printSection("Functions");

		for (const fn of options.functions) {
			const sizeStr = fn.size ? formatSize(fn.size) : undefined;
			let triggerStr: string;

			if (fn.trigger?.type) {
				const triggerType = fn.trigger.type;
				if (triggerType === "schedule" && fn.trigger.config && "every" in fn.trigger.config) {
					triggerStr = `${dimColor}[${triggerType}: ${fn.trigger.config.every}]${resetColor}`;
				} else {
					triggerStr = `${dimColor}[${triggerType}]${resetColor}`;
				}
			} else {
				triggerStr = `${dimColor}[manual]${resetColor}`;
			}

			printLambda(`${fn.name} ${triggerStr}`, sizeStr);
		}
		printBlank();
	}

	// Footer with endpoints
	printDevFooter({
		apiEndpoint: options.apiEndpoint,
		openapiEndpoint: options.openapiEndpoint,
		localstack: options.localstack,
	});
}

/**
 * Print the dev mode footer with endpoints and watching status
 */
export function printDevFooter(options: {
	apiEndpoint?: string;
	openapiEndpoint?: string;
	localstack?: boolean;
}): void {
	printDivider();

	// Endpoints section
	if (options.apiEndpoint) {
		console.log(`  ${dimColor}\u279C${resetColor}  ${boldColor}api${resetColor}       ${cyanColor}${options.apiEndpoint}${resetColor}`);
		if (options.openapiEndpoint) {
			console.log(`  ${dimColor}\u279C${resetColor}  ${boldColor}openapi${resetColor}   ${cyanColor}${options.openapiEndpoint}${resetColor}`);
		}
		printBlank();
	}

	// Status line
	const target = options.localstack ? `${greenColor}LocalStack${resetColor}` : `${yellowColor}AWS${resetColor}`;
	console.log(`  ${dimColor}\u25CF${resetColor} ${dimColor}Watching for changes${resetColor}  ${dimColor}|${resetColor}  ${dimColor}Target:${resetColor} ${target}`);
	printBlank();
}

/**
 * Print an error screen for dev mode
 */
export function printDevError(options: {
	error: string;
	trigger?: string;
}): void {
	logger.error("Build failed");
	if (options.trigger) {
		console.log(`  ${dimColor}Trigger:${resetColor} ${options.trigger}`);
	}
	printBlank();
	console.log(`  ${redColor}${options.error}${resetColor}`);
	printBlank();
	console.log(`  ${dimColor}\u25CB Watching for changes...${resetColor}`);
	printBlank();
}

/**
 * Clear the terminal screen
 */
export function clearScreen(): void {
	process.stdout.write("\x1B[2J\x1B[0f");
}
