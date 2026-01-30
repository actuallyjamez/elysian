/**
 * defineLambda - Define generic Lambda functions
 *
 * Use this in src/functions/ directory to define event-driven Lambda functions
 * that are triggered by SQS, S3, EventBridge schedules, SNS, Kinesis, etc.
 *
 * @example
 * ```ts
 * // src/functions/process-orders.ts - Manual wiring (you create the queue)
 * import { defineLambda } from "@actuallyjamez/elysian";
 *
 * export default defineLambda({
 *   trigger: "sqs",  // Just sets types + IAM, wire in Terraform yourself
 *   handler: async (event) => {
 *     for (const record of event.Records) {
 *       console.log("Processing:", record.body);
 *     }
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // src/functions/process-orders.ts - Auto-create queue
 * import { defineLambda } from "@actuallyjamez/elysian";
 *
 * export default defineLambda({
 *   trigger: {
 *     type: "sqs",
 *     batchSize: 10,
 *     visibilityTimeout: 60,
 *   },
 *   handler: async (event) => {
 *     for (const record of event.Records) {
 *       console.log("Processing:", record.body);
 *     }
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // src/functions/daily-cleanup.ts - Auto-create schedule
 * import { defineLambda } from "@actuallyjamez/elysian";
 *
 * export default defineLambda({
 *   trigger: {
 *     type: "schedule",
 *     every: "1 day",  // or "6 hours", "30 minutes", etc.
 *   },
 *   handler: async (event) => {
 *     console.log("Running daily cleanup...");
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // src/functions/custom.ts - No trigger (invoke manually or wire yourself)
 * import { defineLambda } from "@actuallyjamez/elysian";
 *
 * export default defineLambda({
 *   handler: async (event) => {
 *     return { success: true };
 *   },
 * });
 * ```
 */

import type {
	Context,
	SQSEvent,
	S3Event,
	ScheduledEvent,
	SNSEvent,
	KinesisStreamEvent,
} from "aws-lambda";

// =============================================================================
// Duration Types (ms-style strings)
// =============================================================================

/**
 * Time units supported by the ms package
 * @see https://github.com/vercel/ms
 */
type TimeUnit =
	| "Years" | "Year" | "Yrs" | "Yr" | "Y"
	| "Weeks" | "Week" | "W"
	| "Days" | "Day" | "D"
	| "Hours" | "Hour" | "Hrs" | "Hr" | "H"
	| "Minutes" | "Minute" | "Mins" | "Min" | "M"
	| "Seconds" | "Second" | "Secs" | "Sec" | "s"
	| "Milliseconds" | "Millisecond" | "Msecs" | "Msec" | "Ms";

type TimeUnitAnyCase = TimeUnit | Uppercase<TimeUnit> | Lowercase<TimeUnit>;

/**
 * Duration string using ms syntax (e.g., "1 day", "6 hours", "30 minutes", "1h", "30m")
 * Supports formats like:
 * - "1h", "2d", "30m", "10s" (short format)
 * - "1 hour", "2 days", "30 minutes" (long format)
 * - "1hour", "2days" (no space)
 * @see https://github.com/vercel/ms
 */
export type Duration =
	| `${number}`
	| `${number}${TimeUnitAnyCase}`
	| `${number} ${TimeUnitAnyCase}`;

// =============================================================================
// Trigger Types
// =============================================================================

/**
 * Supported trigger types
 */
export type TriggerType = "sqs" | "s3" | "schedule" | "sns" | "kinesis";

/**
 * Mapping from trigger type to event type
 */
export type TriggerEventMap = {
	sqs: SQSEvent;
	s3: S3Event;
	schedule: ScheduledEvent;
	sns: SNSEvent;
	kinesis: KinesisStreamEvent;
};

// =============================================================================
// Trigger Configuration (for auto-creating resources)
// =============================================================================

/**
 * SQS trigger configuration
 */
export interface SqsTriggerConfig {
	type: "sqs";
	/** Batch size for processing messages (default: 10) */
	batchSize?: number;
	/** Visibility timeout in seconds (default: 30) */
	visibilityTimeout?: number;
	/** Message retention period in seconds (default: 345600 = 4 days) */
	messageRetentionSeconds?: number;
	/** Enable FIFO queue */
	fifo?: boolean;
	/** Enable content-based deduplication (FIFO only) */
	contentBasedDeduplication?: boolean;
}

/**
 * S3 trigger configuration
 */
export interface S3TriggerConfig {
	type: "s3";
	/** S3 event types to trigger on (default: ["s3:ObjectCreated:*"]) */
	events?: string[];
	/** Filter by prefix (e.g., "uploads/") */
	prefix?: string;
	/** Filter by suffix (e.g., ".jpg") */
	suffix?: string;
}

/**
 * Schedule trigger configuration
 */
export interface ScheduleTriggerConfig {
	type: "schedule";
	/** How often to run (e.g., "1 day", "6 hours", "30 minutes", "1h", "30m") */
	every: Duration;
	/** Whether the schedule is enabled (default: true) */
	enabled?: boolean;
}

/**
 * SNS trigger configuration
 */
export interface SnsTriggerConfig {
	type: "sns";
	/** Filter policy for message filtering */
	filterPolicy?: Record<string, unknown>;
}

/**
 * Kinesis trigger configuration
 */
export interface KinesisTriggerConfig {
	type: "kinesis";
	/** Batch size for processing records (default: 100) */
	batchSize?: number;
	/** Starting position: TRIM_HORIZON or LATEST (default: LATEST) */
	startingPosition?: "TRIM_HORIZON" | "LATEST";
	/** Number of shards (default: 1) */
	shardCount?: number;
	/** Retention period in hours (default: 24) */
	retentionPeriodHours?: number;
}

/**
 * Union of all trigger configurations
 */
export type TriggerConfig =
	| SqsTriggerConfig
	| S3TriggerConfig
	| ScheduleTriggerConfig
	| SnsTriggerConfig
	| KinesisTriggerConfig;

/**
 * Trigger can be a simple string or a configuration object
 */
export type Trigger = TriggerType | TriggerConfig;

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Lambda handler function type (context is optional)
 */
export type LambdaHandler<TEvent = unknown, TResult = unknown> = (
	event: TEvent,
	context?: Context,
) => Promise<TResult>;

// =============================================================================
// defineLambda Options
// =============================================================================

/**
 * Extract trigger type from Trigger union
 */
type ExtractTriggerType<T extends Trigger> = T extends TriggerType
	? T
	: T extends TriggerConfig
		? T["type"]
		: never;

/**
 * Options for defineLambda with a trigger (string or config)
 */
export interface DefineLambdaOptionsWithTrigger<
	T extends Trigger,
	TResult = unknown,
> {
	/** The trigger - string for manual wiring, object to auto-create resource */
	trigger: T;
	/** The Lambda handler function */
	handler: LambdaHandler<TriggerEventMap[ExtractTriggerType<T>], TResult>;
}

/**
 * Options for defineLambda without a trigger
 */
export interface DefineLambdaOptionsWithoutTrigger<
	TEvent = unknown,
	TResult = unknown,
> {
	/** Optional trigger - omit for manual invocation */
	trigger?: undefined;
	/** The Lambda handler function */
	handler: LambdaHandler<TEvent, TResult>;
}

// =============================================================================
// Lambda Definition (output type)
// =============================================================================

/**
 * Normalized trigger info stored in the definition
 */
export interface NormalizedTrigger {
	/** The trigger type */
	type: TriggerType;
	/** 
	 * Additional config options (if any exist beyond 'type', resource will be auto-created)
	 * This is the original config object minus the 'type' field
	 */
	config?: Omit<TriggerConfig, "type">;
}

/**
 * Lambda definition returned by defineLambda
 */
export interface LambdaDefinition<TEvent = unknown, TResult = unknown> {
	trigger: NormalizedTrigger | null;
	handler: LambdaHandler<TEvent, TResult>;
	[LAMBDA_MARKER]: true;
}

/**
 * Marker symbol to identify defineLambda exports
 */
export const LAMBDA_MARKER = Symbol.for("elysian.lambda");

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if an export is a defineLambda result
 */
export function isLambdaExport(value: unknown): value is LambdaDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		LAMBDA_MARKER in value &&
		(value as Record<symbol, unknown>)[LAMBDA_MARKER] === true
	);
}

/**
 * Get trigger type from a lambda definition
 */
export function getLambdaTriggerType(
	definition: LambdaDefinition,
): TriggerType | null {
	return definition.trigger?.type ?? null;
}

/**
 * Get full trigger info from a lambda definition
 */
export function getLambdaTrigger(
	definition: LambdaDefinition,
): NormalizedTrigger | null {
	return definition.trigger;
}

/**
 * Check if trigger has config (resource should be auto-created)
 */
export function shouldCreateTriggerResource(
	definition: LambdaDefinition,
): boolean {
	return definition.trigger?.config !== undefined;
}

/**
 * Get handler from a lambda definition
 */
export function getLambdaHandler(
	definition: LambdaDefinition,
): LambdaHandler {
	return definition.handler;
}

// =============================================================================
// defineLambda Function
// =============================================================================

/**
 * Define a Lambda function with a trigger.
 * The event type is automatically inferred from the trigger type.
 */
export function defineLambda<T extends Trigger, TResult = unknown>(
	options: DefineLambdaOptionsWithTrigger<T, TResult>,
): LambdaDefinition<TriggerEventMap[ExtractTriggerType<T>], TResult>;

/**
 * Define a Lambda function without a trigger (manual invocation).
 */
export function defineLambda<TEvent = unknown, TResult = unknown>(
	options: DefineLambdaOptionsWithoutTrigger<TEvent, TResult>,
): LambdaDefinition<TEvent, TResult>;

// Implementation
export function defineLambda<TEvent = unknown, TResult = unknown>(
	options:
		| DefineLambdaOptionsWithTrigger<Trigger, TResult>
		| DefineLambdaOptionsWithoutTrigger<TEvent, TResult>,
): LambdaDefinition<TEvent, TResult> {
	if (!options.handler) {
		throw new Error("defineLambda: handler is required");
	}

	if (typeof options.handler !== "function") {
		throw new Error("defineLambda: handler must be a function");
	}

	// Normalize trigger
	let normalizedTrigger: NormalizedTrigger | null = null;

	if (options.trigger) {
		if (typeof options.trigger === "string") {
			// Simple string trigger - no resource creation
			normalizedTrigger = { type: options.trigger };
		} else {
			// Object trigger - extract type and rest as config
			const { type, ...config } = options.trigger;
			
			// Only include config if there are additional properties
			const hasConfig = Object.keys(config).length > 0;
			
			normalizedTrigger = {
				type,
				...(hasConfig ? { config } : {}),
			};
		}
	}

	return {
		trigger: normalizedTrigger,
		handler: options.handler as LambdaHandler<TEvent, TResult>,
		[LAMBDA_MARKER]: true,
	};
}
