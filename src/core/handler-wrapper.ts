/**
 * Bun plugin to inject Lambda handler wrapper for API route default exports
 *
 * This transforms defineRoutes() exports:
 *   export default defineRoutes().get("/hello", ...)
 *
 * Into:
 *   const __elysia_route__ = defineRoutes().get("/hello", ...)
 *   export default __elysia_route__;
 *   export const handler = __createHandler(__elysia_route__);
 *
 * Generic lambdas (defineLambda) are NOT wrapped - they export their own handler.
 */

import type { BunPlugin } from "bun";

/**
 * Create a Bun plugin that wraps API route default exports with a Lambda handler.
 * This plugin is only used for API routes, not generic lambdas.
 */
export function createApiRouteWrapperPlugin(): BunPlugin {
	return {
		name: "elysian-api-route-wrapper",
		setup(build) {
			// We handle this at the output level instead
			// by appending handler export after bundling
		},
	};
}

// Keep the old name as an alias for backwards compatibility
export const createHandlerWrapperPlugin = createApiRouteWrapperPlugin;

/**
 * Transform source code to add handler export for API routes
 * This is called after the initial bundle to add the handler wrapper
 */
export function wrapWithHandler(code: string): string {
	// Check if there's already a handler export
	if (/export\s+(const|let|var|function)\s+handler\b/.test(code)) {
		return code;
	}

	// Check for default export
	const hasDefaultExport = /export\s+default\s+/.test(code);
	if (!hasDefaultExport) {
		return code;
	}

	// Add the handler wrapper import and export at the end
	const handlerCode = `
// Auto-injected by elysian
import { Hono } from "hono/tiny";
import { handle } from "hono/aws-lambda";

const __defaultExport = await (async () => {
  const mod = await import.meta.require?.("./index.mjs") ?? { default: null };
  return mod.default;
})();

function __createHandler(route) {
  const api = new Hono().mount("/", route.fetch);
  return handle(api);
}

export const handler = __createHandler(__defaultExport);
`;

	return code + handlerCode;
}

/**
 * Transform bundle output for API route Lambda deployment
 * This adds the Hono handler wrapper for API Gateway integration
 */
export function transformBundleForApiRoute(code: string, lambdaName: string): string {
	// If handler already exists, return as-is
	if (/export\s+(const|let|var|function)\s+handler\b/.test(code)) {
		return code;
	}

	// Check for default export
	let hasDefault = /export\s+default\s+/.test(code);
	let modifiedCode = code;

	if (!hasDefault) {
		// Check for named route exports and use the first one
		const namedExportMatch = code.match(
			/export\s+(?:const|let|var)\s+(\w+(?:Route|Lambda|App))\s*=/,
		);
		if (namedExportMatch) {
			modifiedCode += `\nexport default ${namedExportMatch[1]};\n`;
			hasDefault = true;
		}
	}

	if (!hasDefault) {
		console.warn(
			`Warning: No default export or route found in ${lambdaName}. Handler not injected.`,
		);
		return code;
	}

	// Append the handler wrapper for API routes
	const handlerWrapper = `
// ============================================
// Auto-injected Lambda handler by elysian
// ============================================
import { Hono as __Hono } from "hono/tiny";
import { handle as __handle } from "hono/aws-lambda";

// Re-export with handler wrapper
// The default export should be a defineRoutes() result (Elysia instance)
const __route = (await import("./index.mjs")).default;

function __createElysiaHandler(route) {
  if (!route || typeof route.fetch !== "function") {
    throw new Error("Default export must be a defineRoutes() result with .fetch method");
  }
  const api = new __Hono().mount("/", route.fetch);
  return __handle(api);
}

export const handler = __createElysiaHandler(__route);
`;

	return modifiedCode + handlerWrapper;
}

// Keep old function name for backwards compatibility
export const transformBundleForLambda = transformBundleForApiRoute;

/**
 * Get the path to a module from elysian's node_modules
 */
function resolveFromElysian(modulePath: string): string {
	try {
		const resolved = import.meta.resolve(modulePath);
		return resolved.replace("file://", "");
	} catch {
		return modulePath;
	}
}

/**
 * Create a wrapper entry file that imports and re-exports with handler
 * This is used for API routes only
 */
export function createWrapperEntry(originalPath: string): string {
	const honoTinyPath = resolveFromElysian("hono/tiny");
	const honoLambdaPath = resolveFromElysian("hono/aws-lambda");

	return `
import route from "${originalPath}";
import { Hono } from "${honoTinyPath}";
import { handle } from "${honoLambdaPath}";

// Re-export the route as default for introspection
export default route;

// Create and export the Lambda handler
const api = new Hono().mount("/", route.fetch);
export const handler = handle(api);
`;
}

/**
 * Create a wrapper entry file for generic lambdas
 * Generic lambdas use defineLambda() which exports { trigger, handler }
 * We need to extract just the handler for Lambda execution
 */
export function createGenericLambdaWrapper(originalPath: string): string {
	return `
import definition from "${originalPath}";

// Re-export the definition as default for introspection
export default definition;

// Extract and export the handler from the defineLambda definition
export const handler = definition.handler;
`;
}
