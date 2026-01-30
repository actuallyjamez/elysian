/**
 * defineRoutes - Define HTTP API routes for Lambda deployment
 *
 * Use this in src/api/ directory to define HTTP routes that will be
 * deployed to API Gateway.
 *
 * @example
 * ```ts
 * // src/api/users.ts
 * import { defineRoutes, t } from "@actuallyjamez/elysian";
 *
 * export default defineRoutes()
 *   .get("/users", () => db.users.findMany())
 *   .post("/users", ({ body }) => db.users.create(body), {
 *     body: t.Object({ name: t.String() }),
 *   });
 * ```
 */

import Elysia from "elysia";
import { openapi } from "@elysiajs/openapi";

/**
 * OpenAPI configuration (set by build process)
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
 * Marker symbol to identify defineRoutes exports
 */
export const ROUTES_MARKER = Symbol.for("elysian.routes");

/**
 * Type for marked Elysia instance
 */
export type MarkedRoutes<T extends Elysia = Elysia> = T & {
	[ROUTES_MARKER]: true;
};

/**
 * Check if an export is a defineRoutes result
 */
export function isRoutesExport(value: unknown): value is MarkedRoutes {
	return (
		typeof value === "object" &&
		value !== null &&
		ROUTES_MARKER in value &&
		(value as Record<symbol, unknown>)[ROUTES_MARKER] === true
	);
}

/**
 * Create a new Elysia instance pre-configured for Lambda API routes.
 *
 * Returns an Elysia instance with OpenAPI support built-in.
 * Must be used in src/api/ directory only.
 */
export function defineRoutes(): MarkedRoutes {
	const app = new Elysia().use(
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

	// Mark as defineRoutes export for detection
	(app as MarkedRoutes)[ROUTES_MARKER] = true;

	return app as MarkedRoutes;
}
