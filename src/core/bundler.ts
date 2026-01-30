/**
 * Lambda bundler using Bun.build
 *
 * Supports two types of lambdas:
 * - API routes (src/api/) - bundled with Hono handler wrapper
 * - Generic functions (src/functions/) - bundled without wrapper
 */

import { build } from "bun";
import { join } from "path";
import type { ResolvedConfig } from "./config";
import { createApiRouteWrapperPlugin } from "./handler-wrapper";
import type { DiscoveredApiRoute, DiscoveredLambda } from "./discovery";

export interface BundleResult {
	name: string;
	bundleName: string;
	outputPath: string;
	success: boolean;
	error?: string;
	type: "api" | "lambda";
}

/**
 * Bundle a single API route (with Hono wrapper)
 */
export async function bundleApiRoute(
	route: DiscoveredApiRoute,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult> {
	try {
		const result = await build({
			entrypoints: [route.sourcePath],
			outdir: outputDir,
			naming: `${route.bundleName}.js`,
			format: "esm",
			target: "bun",
			external: config.build.external,
			sourcemap: config.build.sourcemap ? "external" : "none",
			minify: config.build.minify,
			plugins: [createApiRouteWrapperPlugin()],
		});

		if (!result.success) {
			const errorMessages = extractBuildErrors(result.logs);
			return {
				name: route.name,
				bundleName: route.bundleName,
				outputPath: join(outputDir, `${route.bundleName}.js`),
				success: false,
				error: errorMessages || "Build failed with no error message",
				type: "api",
			};
		}

		return {
			name: route.name,
			bundleName: route.bundleName,
			outputPath: join(outputDir, `${route.bundleName}.js`),
			success: true,
			type: "api",
		};
	} catch (error) {
		return {
			name: route.name,
			bundleName: route.bundleName,
			outputPath: join(outputDir, `${route.bundleName}.js`),
			success: false,
			error: formatError(error),
			type: "api",
		};
	}
}

/**
 * Bundle a single generic lambda (without wrapper)
 */
export async function bundleGenericLambda(
	lambda: DiscoveredLambda,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult> {
	try {
		const result = await build({
			entrypoints: [lambda.sourcePath],
			outdir: outputDir,
			naming: `${lambda.bundleName}.js`,
			format: "esm",
			target: "bun",
			external: config.build.external,
			sourcemap: config.build.sourcemap ? "external" : "none",
			minify: config.build.minify,
			// No wrapper plugin - generic lambdas export their own handler
		});

		if (!result.success) {
			const errorMessages = extractBuildErrors(result.logs);
			return {
				name: lambda.name,
				bundleName: lambda.bundleName,
				outputPath: join(outputDir, `${lambda.bundleName}.js`),
				success: false,
				error: errorMessages || "Build failed with no error message",
				type: "lambda",
			};
		}

		return {
			name: lambda.name,
			bundleName: lambda.bundleName,
			outputPath: join(outputDir, `${lambda.bundleName}.js`),
			success: true,
			type: "lambda",
		};
	} catch (error) {
		return {
			name: lambda.name,
			bundleName: lambda.bundleName,
			outputPath: join(outputDir, `${lambda.bundleName}.js`),
			success: false,
			error: formatError(error),
			type: "lambda",
		};
	}
}

/**
 * Bundle all API routes
 */
export async function bundleAllApiRoutes(
	routes: DiscoveredApiRoute[],
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult[]> {
	const results: BundleResult[] = [];
	for (const route of routes) {
		const result = await bundleApiRoute(route, outputDir, config);
		results.push(result);
	}
	return results;
}

/**
 * Bundle all generic lambdas
 */
export async function bundleAllGenericLambdas(
	lambdas: DiscoveredLambda[],
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult[]> {
	const results: BundleResult[] = [];
	for (const lambda of lambdas) {
		const result = await bundleGenericLambda(lambda, outputDir, config);
		results.push(result);
	}
	return results;
}

/**
 * Extract error messages from build logs
 */
function extractBuildErrors(logs: readonly { level: string; message: string; position?: { file?: string; line?: number; column?: number } | null }[]): string {
	const errorMessages = logs
		.filter((log) => log.level === "error")
		.map((log) => {
			const position = log.position;
			if (position) {
				return `${position.file}:${position.line}:${position.column}: ${log.message}`;
			}
			return log.message;
		});

	const warningMessages = logs
		.filter((log) => log.level === "warning")
		.map((log) => log.message);

	const allMessages = [...errorMessages, ...warningMessages];

	if (allMessages.length === 0 && logs.length > 0) {
		return logs.map((log) => `[${log.level}] ${log.message}`).join("\n");
	}

	return allMessages.join("\n");
}

/**
 * Format an error for output
 */
function formatError(error: unknown): string {
	if (error instanceof AggregateError && error.errors?.length > 0) {
		const errorMessages = error.errors.map((e: unknown) => {
			if (typeof Bun !== "undefined" && Bun.inspect) {
				return Bun.inspect(e);
			}
			const err = e as { message?: string; position?: { file?: string; line?: number; column?: number } };
			if (err.position) {
				return `${err.position.file}:${err.position.line}:${err.position.column}: ${err.message}`;
			}
			return String(e);
		});
		return errorMessages.join("\n\n");
	}

	if (error instanceof Error) {
		return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
	}

	return String(error);
}

// Legacy function for backwards compatibility during migration
export async function bundleLambda(
	name: string,
	inputPath: string,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult> {
	return bundleApiRoute(
		{ name, sourcePath: inputPath, bundleName: `${config.name}-${name}` },
		outputDir,
		config,
	);
}

export async function bundleAllLambdas(
	lambdaFiles: string[],
	lambdasDir: string,
	outputDir: string,
	config: ResolvedConfig,
): Promise<BundleResult[]> {
	const routes: DiscoveredApiRoute[] = lambdaFiles.map((file) => {
		const name = file.replace(/\.ts$/, "");
		return {
			name,
			sourcePath: join(lambdasDir, file),
			bundleName: `${config.name}-${name}`,
		};
	});
	return bundleAllApiRoutes(routes, outputDir, config);
}
