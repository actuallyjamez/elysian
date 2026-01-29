/**
 * Shared CLI UI utilities for consistent styling across commands
 */

import pc from "picocolors";
import { version } from "../core/version";

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
 * Get color function for HTTP method
 */
export function methodColor(method: string): (text: string) => string {
	switch (method.toUpperCase()) {
		case "GET":
			return pc.green;
		case "POST":
			return pc.blue;
		case "PUT":
			return pc.yellow;
		case "DELETE":
			return pc.red;
		case "PATCH":
			return pc.magenta;
		default:
			return pc.white;
	}
}

/**
 * Spinner frames for loading animation
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Spinner class for showing progress on long-running operations
 */
export class Spinner {
	private message: string;
	private frameIndex: number = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private startTime: number = 0;

	constructor(message: string) {
		this.message = message;
	}

	start(): this {
		this.startTime = Date.now();
		this.frameIndex = 0;

		// Write initial frame
		process.stdout.write(`  ${pc.cyan(SPINNER_FRAMES[0])} ${this.message}`);

		this.interval = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
			// Move cursor to start of line and rewrite
			process.stdout.write(`\r  ${pc.cyan(SPINNER_FRAMES[this.frameIndex])} ${this.message}`);
		}, 80);

		return this;
	}

	stop(): number {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		// Clear the spinner line
		process.stdout.write("\r" + " ".repeat(this.message.length + 10) + "\r");
		return Date.now() - this.startTime;
	}

	succeed(message?: string): number {
		const duration = this.stop();
		console.log(`  ${pc.green("✓")} ${message || this.message}`);
		return duration;
	}

	fail(message?: string): number {
		const duration = this.stop();
		console.log(`  ${pc.red("✗")} ${message || this.message}`);
		return duration;
	}

	update(message: string): void {
		this.message = message;
	}
}

/**
 * Create a new spinner
 */
export function createSpinner(message: string): Spinner {
	return new Spinner(message);
}

/**
 * UI output functions with consistent styling
 */
export const ui = {
	/**
	 * Clear the terminal screen
	 */
	clear: () => {
		process.stdout.write("\x1B[2J\x1B[0f");
	},

	/**
	 * Print header with version and optional mode
	 */
	header: (mode?: string) => {
		console.log();
		console.log(
			`  ${pc.bold(pc.cyan("elysian"))} ${pc.dim(`v${version}`)}${mode ? ` ${mode}` : ""}`,
		);
		console.log();
	},

	/**
	 * Success message with green checkmark
	 */
	success: (msg: string) => {
		console.log(`  ${pc.green("✓")} ${msg}`);
	},

	/**
	 * Error message with red X
	 */
	error: (msg: string) => {
		console.log(`  ${pc.red("✗")} ${msg}`);
	},

	/**
	 * Warning message with yellow exclamation
	 */
	warn: (msg: string) => {
		console.log(`  ${pc.yellow("!")} ${msg}`);
	},

	/**
	 * Info message with dim arrow
	 */
	info: (msg: string) => {
		console.log(`  ${pc.dim("›")} ${msg}`);
	},

	/**
	 * Print a section header
	 */
	section: (title: string) => {
		console.log();
		console.log(`  ${pc.bold(title)}`);
		console.log();
	},

	/**
	 * Print a horizontal divider
	 */
	divider: () => {
		console.log();
		console.log(pc.dim("  " + "─".repeat(40)));
		console.log();
	},

	/**
	 * Print a blank line
	 */
	blank: () => {
		console.log();
	},

	/**
	 * Print indented text
	 */
	indent: (msg: string, level: number = 1) => {
		console.log("  ".repeat(level) + msg);
	},

	/**
	 * Print a key-value pair
	 */
	keyValue: (key: string, value: string, indent: number = 1) => {
		console.log("  ".repeat(indent) + `${pc.dim(key + ":")} ${value}`);
	},

	/**
	 * Print a labeled item (like lambda name with size)
	 */
	labeled: (label: string, suffix?: string) => {
		const suffixStr = suffix ? pc.dim(` (${suffix})`) : "";
		console.log(`  ${pc.dim("λ")} ${pc.bold(label)}${suffixStr}`);
	},

	/**
	 * Print a route line with method coloring
	 */
	route: (method: string, path: string, params?: string[], maxPathLen?: number) => {
		const colorFn = methodColor(method);
		const methodStr = colorFn(method.padEnd(6));
		const pathStr = maxPathLen ? path.padEnd(maxPathLen + 2) : path;
		const paramsStr = params && params.length > 0 ? pc.dim(` [${params.join(", ")}]`) : "";
		console.log(`    ${methodStr} ${pathStr}${paramsStr}`);
	},

	/**
	 * Print watch mode status box
	 */
	watchBox: (options: {
		watching: string[];
		output: string;
		localstack?: boolean;
	}) => {
		console.log();
		console.log(pc.dim("  " + "─".repeat(40)));
		console.log();
		for (const dir of options.watching) {
			console.log(`  ${pc.dim("Watching")}  ${dir}`);
		}
		console.log(`  ${pc.dim("Output")}    ${options.output}`);
		if (options.localstack) {
			console.log(`  ${pc.dim("Deploy")}    ${pc.green("LocalStack")} ${pc.dim("(tflocal)")}`);
		}
		console.log();
		console.log(`  ${pc.dim("Press Ctrl+C to stop")}`);
		console.log();
	},

	/**
	 * Print terraform outputs
	 */
	outputs: (outputs: Record<string, unknown>) => {
		if (Object.keys(outputs).length === 0) return;

		console.log();
		console.log(`  ${pc.bold("Outputs")}`);
		console.log();
		for (const [key, value] of Object.entries(outputs)) {
			const valueStr = typeof value === "string" ? value : JSON.stringify(value);
			console.log(`  ${pc.dim(key + ":")} ${pc.cyan(valueStr)}`);
		}
	},

	/**
	 * Print build/deploy summary with timing
	 */
	summary: (options: {
		lambdas: number;
		routes?: number;
		duration: number;
		action?: string;
	}) => {
		const action = options.action || "Built";
		const routeStr = options.routes !== undefined ? ` (${options.routes} routes)` : "";
		console.log(
			`  ${pc.green("✓")} ${action} ${pc.bold(String(options.lambdas))} lambda${options.lambdas === 1 ? "" : "s"}${routeStr} in ${pc.bold(formatDuration(options.duration))}`,
		);
	},
};

export { pc };
