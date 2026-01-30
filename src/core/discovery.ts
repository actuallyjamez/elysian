/**
 * Lambda Discovery Module
 *
 * Discovers and validates Lambda files in both src/api/ and src/functions/ directories.
 * Enforces that defineRoutes() is used in api/ and defineLambda() is used in functions/.
 */

import { existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import type { ResolvedConfig } from "./config";
import type { TriggerType, NormalizedTrigger } from "../runtime/define-lambda";

/**
 * Callback for logging warnings about skipped files
 */
export type DiscoveryWarningCallback = (filename: string, reason: string) => void;

/**
 * Discovered API route file
 */
export interface DiscoveredApiRoute {
	/** Original filename without extension */
	name: string;
	/** Full path to the source file */
	sourcePath: string;
	/** Lambda bundle name (includes app name prefix) */
	bundleName: string;
}

/**
 * Discovered generic function file
 */
export interface DiscoveredFunction {
	/** Original filename without extension */
	name: string;
	/** Full path to the source file */
	sourcePath: string;
	/** Lambda bundle name (includes app name prefix) */
	bundleName: string;
	/** Trigger type (extracted after bundling) */
	trigger?: TriggerType | null;
}

// Keep old name as alias for backwards compatibility
export type DiscoveredLambda = DiscoveredFunction;

/**
 * Discovery result
 */
export interface DiscoveryResult {
	/** API routes from src/api/ */
	apiRoutes: DiscoveredApiRoute[];
	/** Generic functions from src/functions/ */
	functions: DiscoveredFunction[];
}

/**
 * Validation error
 */
export interface ValidationError {
	file: string;
	message: string;
}

/**
 * List TypeScript files in a directory (non-recursive)
 */
function listTsFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}

	return readdirSync(dir).filter(
		(f) => f.endsWith(".ts") && !f.startsWith("__"),
	);
}

/**
 * Get the lambda bundle name
 */
function getBundleName(appName: string, lambdaName: string): string {
	return `${appName}-${lambdaName}`;
}

/**
 * Check if a TypeScript file has a valid default export.
 * Uses Bun's transpiler to scan exports without full compilation.
 * 
 * @param filePath - Path to the TypeScript file
 * @returns true if the file has a default export, false otherwise
 */
export async function hasValidDefaultExport(filePath: string): Promise<boolean> {
	try {
		const content = await Bun.file(filePath).text();
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const result = transpiler.scan(content);
		return result.exports.includes("default");
	} catch {
		// If we can't parse the file, skip it
		return false;
	}
}

/**
 * Discover all lambda files in both directories
 * Validates that files have default exports before including them.
 * 
 * @param cwd - Current working directory
 * @param config - Resolved configuration
 * @param onWarning - Optional callback for logging warnings about skipped files
 */
export async function discoverLambdas(
	cwd: string,
	config: ResolvedConfig,
	onWarning?: DiscoveryWarningCallback,
): Promise<DiscoveryResult> {
	const apiDir = join(cwd, config.api.dir);
	const functionsDir = join(cwd, config.functions.dir);

	// Discover API routes
	const apiFiles = listTsFiles(apiDir);
	const apiRoutes: DiscoveredApiRoute[] = [];

	for (const file of apiFiles) {
		const sourcePath = join(apiDir, file);
		const hasExport = await hasValidDefaultExport(sourcePath);
		
		if (hasExport) {
			const name = basename(file, ".ts");
			apiRoutes.push({
				name,
				sourcePath,
				bundleName: getBundleName(config.name, name),
			});
		} else {
			if (onWarning) {
				onWarning(file, "no default export");
			}
		}
	}

	// Discover generic functions
	const functionFiles = listTsFiles(functionsDir);
	const functions: DiscoveredFunction[] = [];

	for (const file of functionFiles) {
		const sourcePath = join(functionsDir, file);
		const hasExport = await hasValidDefaultExport(sourcePath);
		
		if (hasExport) {
			const name = basename(file, ".ts");
			functions.push({
				name,
				sourcePath,
				bundleName: getBundleName(config.name, name),
				trigger: undefined, // Will be extracted after bundling
			});
		} else {
			if (onWarning) {
				onWarning(file, "no default export");
			}
		}
	}

	return {
		apiRoutes,
		functions,
	};
}

/**
 * Validate that the correct define* function is used in each directory.
 * This is called after bundling to check the exports.
 *
 * @param modulePath - Path to the bundled module
 * @param expectedType - Expected export type ("routes" or "lambda")
 * @returns Validation error or null if valid
 */
export async function validateExport(
	modulePath: string,
	expectedType: "routes" | "lambda",
	sourceFile: string,
): Promise<ValidationError | null> {
	try {
		const module = await import(modulePath);
		const defaultExport = module.default;

		if (!defaultExport) {
			return {
				file: sourceFile,
				message: "Must have a default export. Use: export default defineRoutes() or export default defineLambda(...)",
			};
		}

		// Check for routes marker
		const hasRoutesMarker =
			typeof defaultExport === "object" &&
			defaultExport !== null &&
			Symbol.for("elysian.routes") in defaultExport;

		// Check for lambda marker
		const hasLambdaMarker =
			typeof defaultExport === "object" &&
			defaultExport !== null &&
			Symbol.for("elysian.lambda") in defaultExport;

		// Check for legacy Elysia export (has .routes array but no marker)
		const isLegacyElysia =
			typeof defaultExport === "object" &&
			defaultExport !== null &&
			"routes" in defaultExport &&
			Array.isArray(defaultExport.routes) &&
			!hasRoutesMarker;

		if (expectedType === "routes") {
			if (hasLambdaMarker) {
				return {
					file: sourceFile,
					message: "defineLambda() cannot be used in src/api/. Use defineRoutes() for API routes.",
				};
			}
			if (isLegacyElysia) {
				return {
					file: sourceFile,
					message: "Raw Elysia exports are not supported. Use: export default defineRoutes().get(...)",
				};
			}
			if (!hasRoutesMarker) {
				return {
					file: sourceFile,
					message: "Files in src/api/ must use defineRoutes(). Use: export default defineRoutes().get(...)",
				};
			}
		} else {
			// expectedType === "lambda"
			if (hasRoutesMarker || isLegacyElysia) {
				return {
					file: sourceFile,
					message: "defineRoutes() cannot be used in src/functions/. Use defineLambda() for generic functions.",
				};
			}
			if (!hasLambdaMarker) {
				return {
					file: sourceFile,
					message: "Files in src/functions/ must use defineLambda(). Use: export default defineLambda('sqs', async (event) => { ... })",
				};
			}
		}

		return null;
	} catch (error) {
		return {
			file: sourceFile,
			message: `Failed to load module: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Extract trigger from a bundled lambda module
 */
export async function extractTrigger(
	modulePath: string,
): Promise<NormalizedTrigger | null> {
	try {
		const module = await import(modulePath);
		const defaultExport = module.default;

		if (
			typeof defaultExport === "object" &&
			defaultExport !== null &&
			"trigger" in defaultExport &&
			defaultExport.trigger !== null
		) {
			return defaultExport.trigger as NormalizedTrigger;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Extract handler from a bundled lambda module
 */
export async function extractHandler(
	modulePath: string,
): Promise<((event: unknown, context: unknown) => Promise<unknown>) | null> {
	try {
		const module = await import(modulePath);
		const defaultExport = module.default;

		if (
			typeof defaultExport === "object" &&
			defaultExport !== null &&
			"handler" in defaultExport &&
			typeof defaultExport.handler === "function"
		) {
			return defaultExport.handler as (event: unknown, context: unknown) => Promise<unknown>;
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Check if api directory exists and has files
 */
export function hasApiRoutes(cwd: string, config: ResolvedConfig): boolean {
	const apiDir = join(cwd, config.api.dir);
	return listTsFiles(apiDir).length > 0;
}

/**
 * Check if functions directory exists and has files
 */
export function hasFunctions(cwd: string, config: ResolvedConfig): boolean {
	const functionsDir = join(cwd, config.functions.dir);
	return listTsFiles(functionsDir).length > 0;
}

// Keep old name as alias for backwards compatibility
export const hasGenericLambdas = hasFunctions;
