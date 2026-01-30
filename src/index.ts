/**
 * elysian - Automatic Lambda bundler for Elysia with API Gateway integration
 *
 * Main library exports for use in configuration and lambda files.
 */

// Re-export config utilities
export { defineConfig, type ElysianConfig, type ResolvedConfig } from "./core/config";

// Re-export type utilities from Elysia
export { t } from "elysia";
export type { AnyElysia } from "elysia";

// Re-export runtime for convenience
export { createHandler } from "./runtime/adapter";

// Export the main defineRoutes and defineLambda helpers
export {
	defineRoutes,
	setOpenApiConfig,
	isRoutesExport,
	ROUTES_MARKER,
	type MarkedRoutes,
} from "./runtime/define-routes";

export {
	defineLambda,
	isLambdaExport,
	getLambdaTrigger,
	getLambdaHandler,
	LAMBDA_MARKER,
	type TriggerType,
	type TriggerEventMap,
	type LambdaHandler,
	type LambdaDefinition,
} from "./runtime/define-lambda";
