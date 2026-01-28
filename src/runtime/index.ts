/**
 * elysia-apigw runtime exports
 *
 * This module is imported at runtime in Lambda functions.
 * Keep it minimal to reduce bundle size.
 */

export { createHandler, type LambdaHandler } from "./adapter";
export type * from "./types";
