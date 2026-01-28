/**
 * elysian - Automatic Lambda bundler for Elysia with API Gateway integration
 *
 * Main library exports for use in configuration and lambda files.
 */

import Elysia from "elysia";
import { openapi } from "@elysiajs/openapi";

// Re-export config utilities
export { defineConfig, type ElysianConfig, type ResolvedConfig } from "./core/config";

// Re-export type utilities from Elysia
export { t } from "elysia";
export type { AnyElysia } from "elysia";

// Re-export runtime for convenience
export { createHandler } from "./runtime/adapter";

/**
 * Default OpenAPI configuration for lambdas
 * Can be overridden via config file
 */
let openApiConfig = {
	title: "API",
	version: "1.0.0",
	description: "",
};

/**
 * Set the OpenAPI configuration (called by build process)
 */
export function setOpenApiConfig(config: {
	title?: string;
	version?: string;
	description?: string;
}): void {
	openApiConfig = { ...openApiConfig, ...config };
}

/**
 * Create a new Elysia instance pre-configured for Lambda use
 *
 * This is the main entry point for defining Lambda routes.
 * The returned Elysia instance has OpenAPI support built-in.
 *
 * @example
 * ```ts
 * import { createLambda, t } from "@actuallyjamez/elysian";
 *
 * export default createLambda()
 *   .get("/hello", () => "Hello World", {
 *     response: t.String(),
 *   })
 *   .get("/users/:id", ({ params }) => getUser(params.id), {
 *     params: t.Object({ id: t.String() }),
 *   });
 * ```
 */
export function createLambda(): Elysia {
	return new Elysia().use(
		openapi({
			documentation: {
				info: {
					title: openApiConfig.title,
					version: openApiConfig.version,
					description: openApiConfig.description,
				},
			},
		}),
	);
}
