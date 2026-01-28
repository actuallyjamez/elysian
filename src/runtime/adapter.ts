/**
 * Runtime adapter for AWS Lambda
 *
 * This module provides the Lambda handler creation function
 * that bridges Elysia apps to AWS Lambda via Hono.
 */

import type { AnyElysia } from "elysia";
import { Hono } from "hono/tiny";
import { handle, type LambdaEvent, type LambdaContext } from "hono/aws-lambda";

/**
 * Lambda handler type compatible with API Gateway v2
 */
export type LambdaHandler = (
	event: LambdaEvent,
	context?: LambdaContext,
) => Promise<{
	statusCode: number;
	body: string;
	headers?: Record<string, string>;
	isBase64Encoded: boolean;
}>;

/**
 * Create an AWS Lambda handler from an Elysia app
 *
 * @param app - An Elysia application instance
 * @returns AWS Lambda handler function
 *
 * @example
 * ```ts
 * import { createLambda, createHandler } from "elysia-apigw/runtime";
 *
 * const app = createLambda().get("/hello", () => "Hello World");
 * export const handler = createHandler(app);
 * ```
 */
export function createHandler(app: AnyElysia): LambdaHandler {
	if (!app || typeof app.fetch !== "function") {
		throw new Error(
			"createHandler requires an Elysia app instance with a .fetch method",
		);
	}

	const hono = new Hono().mount("/", app.fetch);
	return handle(hono) as LambdaHandler;
}
