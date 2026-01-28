/**
 * Route manifest generation through introspection of built lambdas
 */

import { join, isAbsolute } from "path";
import { getLambdaBundleName } from "./naming";

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

export interface ApiManifest {
	lambdas: LambdaManifest[];
	routes: ApiRoute[];
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
 * Generate manifest by introspecting built lambda modules
 */
export async function generateManifest(
	lambdaFiles: string[],
	outputDir: string,
	openapiEnabled: boolean = true,
	apiName: string = "",
): Promise<ApiManifest> {
	const manifest: ApiManifest = {
		lambdas: [],
		routes: [],
	};

	// Track routes with their source lambda for conflict detection
	const routeOwners = new Map<string, string>();
	const conflicts: RouteConflict[] = [];
	const sortedFiles = [...lambdaFiles].sort();

	for (const file of sortedFiles) {
		const originalName = file.replace(/\.ts$/, "");
		// Use prefixed bundle name for file lookup
		const bundleName = apiName ? getLambdaBundleName(apiName, originalName) : originalName;
		const modulePath = isAbsolute(outputDir)
			? join(outputDir, `${bundleName}.js`)
			: join(process.cwd(), outputDir, `${bundleName}.js`);

		// Add cache-busting query param to force fresh import
		const module = await import(`${modulePath}?t=${Date.now()}`);

		const lambdaManifest: LambdaManifest = {
			name: bundleName,
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
				let targetLambda = bundleName;

				// OpenAPI routes always go to the __openapi__ lambda if enabled
				if (openapiEnabled && path.startsWith("/openapi")) {
					targetLambda = apiName ? getLambdaBundleName(apiName, "__openapi__") : "__openapi__";
				} else if (originalName === "__openapi__") {
					// Skip non-openapi routes from the openapi aggregator lambda
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

					manifest.routes.push({
						method,
						path,
						lambda: targetLambda,
						pathParameters,
						apiGatewayPath: convertToApiGatewayPath(path),
					});
				}
			}
		}

		manifest.lambdas.push(lambdaManifest);
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

	return manifest;
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
