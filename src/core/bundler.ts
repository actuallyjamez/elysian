/**
 * Lambda bundler using Bun.build
 */

import { build, type BuildConfig as BunBuildConfig } from "bun";
import { join } from "path";
import type { ResolvedConfig } from "./config";
import { createHandlerWrapperPlugin } from "./handler-wrapper";

export interface BundleResult {
	name: string;
	outputPath: string;
	success: boolean;
	error?: string;
}

/**
 * Bundle a single lambda file
 */
export async function bundleLambda(
	name: string,
	inputPath: string,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult> {
	try {
		const result = await build({
			entrypoints: [inputPath],
			outdir: outputDir,
			naming: `${name}.js`,
			format: "esm",
			target: "bun",
			external: config.build.external,
			sourcemap: config.build.sourcemap ? "external" : "none",
			minify: config.build.minify,
			plugins: [createHandlerWrapperPlugin()],
		});

		if (!result.success) {
			// Extract detailed error messages from build logs
			const errorMessages = result.logs
				.filter((log) => log.level === "error")
				.map((log) => {
					// Include file position if available
					const position = log.position;
					if (position) {
						return `${position.file}:${position.line}:${position.column}: ${log.message}`;
					}
					return log.message;
				});
			
			// Also include warnings that might be relevant
			const warningMessages = result.logs
				.filter((log) => log.level === "warning")
				.map((log) => log.message);
			
			const allMessages = [...errorMessages, ...warningMessages];

			// If no messages captured, try to get string representation of all logs
			if (allMessages.length === 0 && result.logs.length > 0) {
				const allLogs = result.logs.map((log) => `[${log.level}] ${log.message}`);
				return {
					name,
					outputPath: join(outputDir, `${name}.js`),
					success: false,
					error: allLogs.join("\n") || "Build failed with no error message",
				};
			}
			
			return {
				name,
				outputPath: join(outputDir, `${name}.js`),
				success: false,
				error: allMessages.length > 0 ? allMessages.join("\n") : "Build failed with no error message",
			};
		}

		return {
			name,
			outputPath: join(outputDir, `${name}.js`),
			success: true,
		};
	} catch (error) {
		// Handle AggregateError from Bun bundler (contains detailed parse errors)
		if (error instanceof AggregateError && error.errors?.length > 0) {
			const errorMessages = error.errors.map((e: unknown) => {
				// Use Bun.inspect for nicely formatted error output
				if (typeof Bun !== "undefined" && Bun.inspect) {
					return Bun.inspect(e);
				}
				// Fallback: try to extract message and position
				const err = e as { message?: string; position?: { file?: string; line?: number; column?: number } };
				if (err.position) {
					return `${err.position.file}:${err.position.line}:${err.position.column}: ${err.message}`;
				}
				return String(e);
			});
			return {
				name,
				outputPath: join(outputDir, `${name}.js`),
				success: false,
				error: errorMessages.join("\n\n"),
			};
		}
		
		// Capture full error details including stack trace
		const errorMessage = error instanceof Error 
			? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
			: String(error);
		return {
			name,
			outputPath: join(outputDir, `${name}.js`),
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Bundle all lambda files in a directory
 */
export async function bundleAllLambdas(
	lambdaFiles: string[],
	lambdasDir: string,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult[]> {
	const results: BundleResult[] = [];

	for (const file of lambdaFiles) {
		const name = file.replace(/\.ts$/, "");
		const inputPath = join(lambdasDir, file);
		const result = await bundleLambda(name, inputPath, outputDir, config);
		results.push(result);
	}

	return results;
}
