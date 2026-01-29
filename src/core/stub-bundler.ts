/**
 * Stub Lambda bundler for Live mode
 *
 * Bundles the stub Lambda (src/runtime/stub.ts) into dist/__stub__/
 * for deployment to AWS/LocalStack in dev mode.
 */

import { build } from "bun";
import { join, dirname } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import { fileURLToPath } from "url";

export interface StubBundleResult {
	success: boolean;
	outputDir: string;
	error?: string;
}

/**
 * Get the path to the stub source file
 * Works both when running from source and when installed as a package
 */
function getStubSourcePath(): string {
	// When running from source, __dirname equivalent points to src/core
	// The stub is at src/runtime/stub.ts
	const currentDir = dirname(fileURLToPath(import.meta.url));

	// Try source location first (development)
	const sourcePath = join(currentDir, "..", "runtime", "stub.ts");
	if (existsSync(sourcePath)) {
		return sourcePath;
	}

	// Try dist location (when installed as package)
	const distPath = join(currentDir, "..", "runtime", "stub.js");
	if (existsSync(distPath)) {
		return distPath;
	}

	// Fallback: look relative to cwd in node_modules
	const nodeModulesPath = join(
		process.cwd(),
		"node_modules",
		"elysian",
		"dist",
		"runtime",
		"stub.js",
	);
	if (existsSync(nodeModulesPath)) {
		return nodeModulesPath;
	}

	throw new Error(
		`Could not find stub source file. Checked:\n  - ${sourcePath}\n  - ${distPath}\n  - ${nodeModulesPath}`,
	);
}

/**
 * Bundle and package the stub Lambda
 *
 * @param outputDir - The project's output directory (e.g., dist/)
 * @returns Result with success status and output directory path
 */
export async function bundleStub(outputDir: string): Promise<StubBundleResult> {
	const stubDir = join(outputDir, "__stub__");

	try {
		// Ensure output directory exists
		mkdirSync(stubDir, { recursive: true });

		// Get the stub source path
		const stubSourcePath = getStubSourcePath();

		// Bundle the stub Lambda
		const result = await build({
			entrypoints: [stubSourcePath],
			outdir: stubDir,
			naming: "index.mjs",
			format: "esm",
			target: "node", // Lambda uses Node.js runtime, not Bun
			minify: true,
			sourcemap: "none",
			// No external dependencies - bundle everything
			external: [],
		});

		if (!result.success) {
			const errorMessages = result.logs
				.filter((log) => log.level === "error")
				.map((log) => log.message);

			return {
				success: false,
				outputDir: stubDir,
				error:
					errorMessages.length > 0
						? errorMessages.join("\n")
						: "Stub bundle failed with no error message",
			};
		}

		return {
			success: true,
			outputDir: stubDir,
		};
	} catch (error) {
		return {
			success: false,
			outputDir: stubDir,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Clean up the stub directory
 */
export function cleanStub(outputDir: string): void {
	const stubDir = join(outputDir, "__stub__");
	if (existsSync(stubDir)) {
		rmSync(stubDir, { recursive: true, force: true });
	}
}

/**
 * Check if stub is already bundled and up to date
 * Returns true if stub exists, false if needs rebuild
 */
export function isStubBundled(outputDir: string): boolean {
	const stubFile = join(outputDir, "__stub__", "index.mjs");
	return existsSync(stubFile);
}
