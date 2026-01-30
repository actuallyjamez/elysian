/**
 * Route manifest generation through introspection of built lambdas
 */

import { join, isAbsolute } from "path";
import { getLambdaBundleName } from "./naming";
import type { TriggerType, NormalizedTrigger } from "../runtime/define-lambda";
import type { DiscoveredApiRoute, DiscoveredFunction, DiscoveredLambda } from "./discovery";

export interface RouteInfo {
	method: string;
	path: string;
	pathParameters: string[];
}

export interface LambdaManifest {
	name: string;
	routes: RouteInfo[];
}

export interface ApiRoute {
	method: string;
	path: string;
	lambda: string;
	pathParameters: string[];
	apiGatewayPath: string;
}

/**
 * Generic lambda manifest entry
 */
export interface GenericLambdaManifest {
	name: string;
	bundleName: string;
	/** Normalized trigger info (type + optional create config) */
	trigger: NormalizedTrigger | null;
}

export interface ApiManifest {
	/** API route lambdas (from src/api/) */
	lambdas: LambdaManifest[];
	/** API Gateway routes */
	routes: ApiRoute[];
	/** Generic functions/lambdas (from src/functions/) */
	genericLambdas: GenericLambdaManifest[];
}

/**
 * Convert Elysia path params (:id) to API Gateway format ({id})
 */
export function convertToApiGatewayPath(path: string): string {
	return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Extract path parameters from a route path
 */
export function extractPathParameters(path: string): string[] {
	const matches = path.match(/:([^/]+)/g);
	return matches ? matches.map((m) => m.slice(1)) : [];
}

/**
 * Generate a valid Terraform resource name from route info
 */
export function generateRouteName(
	lambda: string,
	method: string,
	path: string,
): string {
	const sanitizedPath = path
		.replace(/^\//, "")
		.replace(/\//g, "_")
		.replace(/:/g, "")
		.replace(/[{}]/g, "")
		.replace(/_$/, "");
	return `${lambda}_${method.toLowerCase()}_${sanitizedPath || "root"}`;
}

interface RouteConflict {
	route: string;
	lambdas: string[];
}

/**
 * Generate manifest for API routes by introspecting built lambda modules
 */
export async function generateApiRoutesManifest(
	apiRoutes: DiscoveredApiRoute[],
	outputDir: string,
	openapiEnabled: boolean = true,
	appName: string = "",
): Promise<{ lambdas: LambdaManifest[]; routes: ApiRoute[] }> {
	const lambdas: LambdaManifest[] = [];
	const routes: ApiRoute[] = [];

	// Track routes with their source lambda for conflict detection
	const routeOwners = new Map<string, string>();
	const conflicts: RouteConflict[] = [];

	for (const apiRoute of apiRoutes) {
		const modulePath = isAbsolute(outputDir)
			? join(outputDir, `${apiRoute.bundleName}.js`)
			: join(process.cwd(), outputDir, `${apiRoute.bundleName}.js`);

		// Add cache-busting query param to force fresh import
		const module = await import(`${modulePath}?t=${Date.now()}`);

		const lambdaManifest: LambdaManifest = {
			name: apiRoute.bundleName,
			routes: [],
		};

		// Find all exported Elysia routes (objects with .routes array)
		const exportedRoutes = Object.values(module).filter(
			(exp: unknown): exp is { routes: Array<{ method: string; path: string }> } =>
				exp !== null &&
				typeof exp === "object" &&
				"routes" in exp &&
				Array.isArray((exp as { routes: unknown }).routes),
		);

		for (const route of exportedRoutes) {
			for (const r of route.routes) {
				const method = r.method.toUpperCase();
				const path = r.path as string;
				const routeKey = `${method} ${path}`;
				const pathParameters = extractPathParameters(path);

				lambdaManifest.routes.push({
					method,
					path,
					pathParameters,
				});

				// Determine which lambda should handle this route
				let targetLambda = apiRoute.bundleName;

				// OpenAPI routes always go to openapi lambda if enabled
				const openapiLambdaName = appName ? getLambdaBundleName(appName, "openapi") : "openapi";
				if (openapiEnabled && path.startsWith("/openapi")) {
					targetLambda = openapiLambdaName;
				} else if (apiRoute.name === "openapi") {
					// Skip non-openapi routes from openapi aggregator lambda
					continue;
				}

				// Check for route conflicts
				const existingOwner = routeOwners.get(routeKey);
				if (existingOwner && existingOwner !== targetLambda) {
					const existingConflict = conflicts.find((c) => c.route === routeKey);
					if (existingConflict) {
						if (!existingConflict.lambdas.includes(targetLambda)) {
							existingConflict.lambdas.push(targetLambda);
						}
					} else {
						conflicts.push({
							route: routeKey,
							lambdas: [existingOwner, targetLambda],
						});
					}
					continue;
				}

				if (!routeOwners.has(routeKey)) {
					routeOwners.set(routeKey, targetLambda);

					routes.push({
						method,
						path,
						lambda: targetLambda,
						pathParameters,
						apiGatewayPath: convertToApiGatewayPath(path),
					});
				}
			}
		}

		lambdas.push(lambdaManifest);
	}

	// Report conflicts and fail if any exist
	if (conflicts.length > 0) {
		const conflictMessages = conflicts
			.map((c) => `  ${c.route} is defined in: ${c.lambdas.join(", ")}`)
			.join("\n");
		throw new Error(
			`Route conflicts detected:\n${conflictMessages}\n\nEach route must be handled by exactly one lambda.`,
		);
	}

	return { lambdas, routes };
}

/**
 * Generate manifest for generic functions by extracting trigger info
 */
export async function generateGenericLambdasManifest(
	functions: DiscoveredFunction[],
	outputDir: string,
): Promise<GenericLambdaManifest[]> {
	const result: GenericLambdaManifest[] = [];

	for (const fn of functions) {
		const modulePath = isAbsolute(outputDir)
			? join(outputDir, `${fn.bundleName}.js`)
			: join(process.cwd(), outputDir, `${fn.bundleName}.js`);

		// Add cache-busting query param to force fresh import
		const module = await import(`${modulePath}?t=${Date.now()}`);
		const defaultExport = module.default;

		// Extract trigger from defineLambda export
		// trigger is now { type, create? } or null
		let trigger: NormalizedTrigger | null = null;
		if (
			defaultExport &&
			typeof defaultExport === "object" &&
			"trigger" in defaultExport &&
			defaultExport.trigger !== null
		) {
			trigger = defaultExport.trigger as NormalizedTrigger;
		}

		result.push({
			name: fn.name,
			bundleName: fn.bundleName,
			trigger,
		});
	}

	return result;
}

/**
 * Generate full manifest for both API routes and generic functions
 */
export async function generateManifest(
	apiRoutes: DiscoveredApiRoute[],
	genericFunctions: DiscoveredFunction[],
	outputDir: string,
	openapiEnabled: boolean = true,
	appName: string = "",
): Promise<ApiManifest> {
	const { lambdas, routes } = await generateApiRoutesManifest(
		apiRoutes,
		outputDir,
		openapiEnabled,
		appName,
	);

	const genericLambdasManifest = await generateGenericLambdasManifest(
		genericFunctions,
		outputDir,
	);

	return {
		lambdas,
		routes,
		genericLambdas: genericLambdasManifest,
	};
}

/**
 * Write manifest to JSON file
 */
export async function writeManifest(
	manifest: ApiManifest,
	outputPath: string,
): Promise<void> {
	await Bun.write(outputPath, JSON.stringify(manifest, null, 2));
}

/**
 * Result of comparing two manifests
 */
export interface ManifestDiff {
	/** Whether terraform needs to be re-applied */
	requiresTerraform: boolean;
	/** Summary of what changed */
	changes: string[];
}

/**
 * Compare two manifests to determine if terraform needs to be re-applied.
 * 
 * Changes that require terraform:
 * - Lambda added or removed
 * - API route added or removed
 * - Trigger type changed (schedule/sqs/eventbridge added or removed)
 * - Trigger config changed (e.g., schedule expression, SQS queue name)
 * 
 * Changes that DON'T require terraform:
 * - Lambda code changes (just need to reload workers)
 */
export function compareManifests(
	oldManifest: ApiManifest | null,
	newManifest: ApiManifest,
): ManifestDiff {
	const changes: string[] = [];
	let requiresTerraform = false;

	// No previous manifest = first build, always needs terraform
	if (!oldManifest) {
		return { requiresTerraform: true, changes: ["Initial deployment"] };
	}

	// Compare API routes
	const oldRouteKeys = new Set(oldManifest.routes.map(r => `${r.method} ${r.path}`));
	const newRouteKeys = new Set(newManifest.routes.map(r => `${r.method} ${r.path}`));

	// Check for added routes
	for (const key of newRouteKeys) {
		if (!oldRouteKeys.has(key)) {
			changes.push(`Route added: ${key}`);
			requiresTerraform = true;
		}
	}

	// Check for removed routes
	for (const key of oldRouteKeys) {
		if (!newRouteKeys.has(key)) {
			changes.push(`Route removed: ${key}`);
			requiresTerraform = true;
		}
	}

	// Compare generic lambdas
	const oldLambdaMap = new Map(
		oldManifest.genericLambdas.map(l => [l.bundleName, l])
	);
	const newLambdaMap = new Map(
		newManifest.genericLambdas.map(l => [l.bundleName, l])
	);

	// Check for added lambdas
	for (const [bundleName, lambda] of newLambdaMap) {
		if (!oldLambdaMap.has(bundleName)) {
			changes.push(`Lambda added: ${lambda.name}`);
			requiresTerraform = true;
		}
	}

	// Check for removed lambdas
	for (const [bundleName, lambda] of oldLambdaMap) {
		if (!newLambdaMap.has(bundleName)) {
			changes.push(`Lambda removed: ${lambda.name}`);
			requiresTerraform = true;
		}
	}

	// Compare trigger configurations for existing lambdas
	for (const [bundleName, newLambda] of newLambdaMap) {
		const oldLambda = oldLambdaMap.get(bundleName);
		if (!oldLambda) continue;

		const oldTrigger = oldLambda.trigger;
		const newTrigger = newLambda.trigger;

		// Trigger added
		if (!oldTrigger && newTrigger) {
			changes.push(`${newLambda.name}: trigger added (${newTrigger.type})`);
			requiresTerraform = true;
			continue;
		}

		// Trigger removed
		if (oldTrigger && !newTrigger) {
			changes.push(`${newLambda.name}: trigger removed (was ${oldTrigger.type})`);
			requiresTerraform = true;
			continue;
		}

		// Both have triggers - compare them
		if (oldTrigger && newTrigger) {
			// Type changed
			if (oldTrigger.type !== newTrigger.type) {
				changes.push(`${newLambda.name}: trigger type changed (${oldTrigger.type} -> ${newTrigger.type})`);
				requiresTerraform = true;
				continue;
			}

			// Config changed (deep compare)
			const oldConfig = JSON.stringify(oldTrigger.config || {});
			const newConfig = JSON.stringify(newTrigger.config || {});
			if (oldConfig !== newConfig) {
				changes.push(`${newLambda.name}: trigger config changed`);
				requiresTerraform = true;
			}
		}
	}

	// Compare API route lambdas (check if any were added/removed)
	const oldApiLambdas = new Set(oldManifest.lambdas.map(l => l.name));
	const newApiLambdas = new Set(newManifest.lambdas.map(l => l.name));

	for (const name of newApiLambdas) {
		if (!oldApiLambdas.has(name)) {
			changes.push(`API lambda added: ${name}`);
			requiresTerraform = true;
		}
	}

	for (const name of oldApiLambdas) {
		if (!newApiLambdas.has(name)) {
			changes.push(`API lambda removed: ${name}`);
			requiresTerraform = true;
		}
	}

	return { requiresTerraform, changes };
}

// Legacy function signature for backwards compatibility
export async function generateManifestLegacy(
	lambdaFiles: string[],
	outputDir: string,
	openapiEnabled: boolean = true,
	name: string = "",
): Promise<ApiManifest> {
	// Convert to new format
	const apiRoutes: DiscoveredApiRoute[] = lambdaFiles.map((file) => {
		const originalName = file.replace(/\.ts$/, "");
		return {
			name: originalName,
			sourcePath: "", // Not needed for manifest generation
			bundleName: name ? getLambdaBundleName(name, originalName) : originalName,
		};
	});

	return generateManifest(apiRoutes, [], outputDir, openapiEnabled, name);
}
