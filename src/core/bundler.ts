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
			const errors = result.logs
				.filter((log) => log.level === "error")
				.map((log) => log.message)
				.join("\n");
			return {
				name,
				outputPath: join(outputDir, `${name}.js`),
				success: false,
				error: errors || "Unknown build error",
			};
		}

		return {
			name,
			outputPath: join(outputDir, `${name}.js`),
			success: true,
		};
	} catch (error) {
		return {
			name,
			outputPath: join(outputDir, `${name}.js`),
			success: false,
			error: error instanceof Error ? error.message : String(error),
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
