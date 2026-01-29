/**
 * Bun plugin to inject Lambda handler wrapper for default exports
 *
 * This transforms:
 *   export default createLambda().get("/hello", ...)
 *
 * Into:
 *   const __elysia_route__ = createLambda().get("/hello", ...)
 *   export default __elysia_route__;
 *   export const handler = __createHandler(__elysia_route__);
 */

import type { BunPlugin } from "bun";

/**
 * Create a Bun plugin that wraps default Elysia exports with a Lambda handler
 */
export function createHandlerWrapperPlugin(): BunPlugin {
	return {
		name: "elysia-apigw-handler-wrapper",
		setup(build) {
			// We'll handle this at the output level instead
			// by appending handler export after bundling
		},
	};
}

/**
 * Transform source code to add handler export
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
// Auto-injected by elysia-apigw
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
 * Alternative approach: Transform the bundle output directly
 * This rewrites the code to capture the default export and wrap it
 */
export function transformBundleForLambda(code: string, lambdaName: string): string {
	// If handler already exists, return as-is
	if (/export\s+(const|let|var|function)\s+handler\b/.test(code)) {
		return code;
	}

	// Find and capture default export, wrap with handler
	// We use a simple regex-based approach for common patterns

	// Pattern 1: export default <identifier>;
	// Pattern 2: export default createLambda()...;
	// Pattern 3: export { something as default };

	// The safest approach is to append a wrapper that re-imports the module
	// But for a single-file bundle, we need a different strategy

	// For bundled output, we'll use a post-processing approach:
	// 1. Replace "export default X" with "const __defaultRoute__ = X; export default __defaultRoute__"
	// 2. Append handler creation

	// Match various default export patterns
	const patterns = [
		// export default identifier;
		/export\s+default\s+(\w+)\s*;/,
		// export default expression (function call, object, etc)
		/export\s+default\s+/,
	];

	let hasDefault = false;
	let modifiedCode = code;

	// Check if code has default export
	if (/export\s+default\s+/.test(code)) {
		hasDefault = true;
	}

	if (!hasDefault) {
		// No default export, check for named route exports and use the first one
		const namedExportMatch = code.match(
			/export\s+(?:const|let|var)\s+(\w+(?:Route|Lambda|App))\s*=/,
		);
		if (namedExportMatch) {
			// Add default export for the route
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

	// Append the handler wrapper
	const handlerWrapper = `
// ============================================
// Auto-injected Lambda handler by elysia-apigw
// ============================================
import { Hono as __Hono } from "hono/tiny";
import { handle as __handle } from "hono/aws-lambda";

// Re-export with handler wrapper
// The default export should be an Elysia instance
const __route = (await import("./index.mjs")).default;

function __createElysiaHandler(route) {
  if (!route || typeof route.fetch !== "function") {
    throw new Error("Default export must be an Elysia instance with .fetch method");
  }
  const api = new __Hono().mount("/", route.fetch);
  return __handle(api);
}

export const handler = __createElysiaHandler(__route);
`;

	return modifiedCode + handlerWrapper;
}

/**
 * Get the path to a module from elysian's node_modules
 */
function resolveFromElysian(modulePath: string): string {
	// Use import.meta.resolve to get the absolute path
	// This resolves relative to where this code is located (elysian package)
	try {
		const resolved = import.meta.resolve(modulePath);
		// Convert file:// URL to path
		return resolved.replace("file://", "");
	} catch {
		// Fallback to relative import if resolution fails
		return modulePath;
	}
}

/**
 * Create a wrapper entry file that imports and re-exports with handler
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
