/**
 * LocalStack detection and tflocal execution utilities
 */

import { existsSync } from "fs";
import { join } from "path";

export interface TerraformOutput {
	[key: string]: {
		value: unknown;
		type?: string;
		sensitive?: boolean;
	};
}

export interface TfResult {
	success: boolean;
	error?: string;
}

/**
 * Check if LocalStack is running by hitting the health endpoint
 */
export async function isLocalStackRunning(
	endpoint: string = "http://localhost:4566",
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);

		const response = await fetch(`${endpoint}/_localstack/health`, {
			signal: controller.signal,
		});

		clearTimeout(timeout);
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Check if tflocal CLI is installed
 */
export async function isTfLocalInstalled(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["tflocal", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check if terraform has been initialized in the given directory
 */
export function isTerraformInitialized(terraformDir: string): boolean {
	return existsSync(join(terraformDir, ".terraform"));
}

/**
 * Run tflocal init
 */
export async function runTfLocalInit(terraformDir: string): Promise<TfResult> {
	try {
		const proc = Bun.spawn(["tflocal", "init", "-input=false"], {
			cwd: terraformDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			return { success: false, error: stderr };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Run tflocal apply with auto-approve
 */
export async function runTfLocalApply(terraformDir: string): Promise<TfResult> {
	try {
		const proc = Bun.spawn(
			["tflocal", "apply", "-auto-approve", "-input=false"],
			{
				cwd: terraformDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			const stdout = await new Response(proc.stdout).text();
			// Terraform often outputs errors to stdout
			return { success: false, error: stderr || stdout };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Transform AWS URLs to LocalStack URLs
 * Converts URLs like:
 *   https://abc123.execute-api.eu-west-2.amazonaws.com/
 * To:
 *   http://abc123.execute-api.localhost.localstack.cloud:4566/
 *
 * Also handles AppSync endpoints:
 *   https://abc123.appsync-api.eu-west-2.amazonaws.com/event
 * To:
 *   http://localhost:4566/appsync-api/abc123/event
 *
 * And AppSync Realtime endpoints:
 *   wss://abc123.appsync-realtime-api.eu-west-2.amazonaws.com/event/realtime
 * To:
 *   ws://localhost:4566/appsync-api/abc123/event/realtime
 *
 * Also handles LocalStack's own format (which may lack scheme):
 *   abc123.appsync-realtime-api.localhost.localstack.cloud:4566/...
 * To:
 *   ws://abc123.appsync-realtime-api.localhost.localstack.cloud:4566/...
 */
export function transformToLocalStackUrl(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}

	let result = value;

	// Match API Gateway URLs: https://{api-id}.execute-api.{region}.amazonaws.com
	const apiGatewayPattern =
		/https:\/\/([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(\/.*)?/gi;

	result = result.replace(apiGatewayPattern, (match, apiId, region, path) => {
		const pathSuffix = path || "";
		return `http://${apiId}.execute-api.localhost.localstack.cloud:4566${pathSuffix}`;
	});

	// Match AppSync HTTP endpoints: https://{api-id}.appsync-api.{region}.amazonaws.com/...
	const appsyncHttpPattern =
		/https:\/\/([a-z0-9]+)\.appsync-api\.([a-z0-9-]+)\.amazonaws\.com(\/.*)?/gi;

	result = result.replace(appsyncHttpPattern, (match, apiId, region, path) => {
		const pathSuffix = path || "";
		return `http://localhost:4566/appsync-api/${apiId}${pathSuffix}`;
	});

	// Match AppSync Realtime endpoints: wss://{api-id}.appsync-realtime-api.{region}.amazonaws.com/...
	const appsyncRealtimePattern =
		/wss:\/\/([a-z0-9]+)\.appsync-realtime-api\.([a-z0-9-]+)\.amazonaws\.com(\/.*)?/gi;

	result = result.replace(
		appsyncRealtimePattern,
		(match, apiId, region, path) => {
			const pathSuffix = path || "";
			return `ws://localhost:4566/appsync-api/${apiId}${pathSuffix}`;
		},
	);

	// Handle LocalStack's own format for AppSync HTTP (may lack scheme or have http://)
	// Pattern: {api-id}.appsync-api.localhost.localstack.cloud:4566/...
	// Ensure it has http:// scheme
	const localstackAppsyncHttpPattern =
		/^(?:https?:\/\/)?([a-z0-9]+)\.appsync-api\.localhost\.localstack\.cloud:(\d+)(\/.*)?$/i;

	const httpMatch = result.match(localstackAppsyncHttpPattern);
	if (httpMatch) {
		const [, apiId, port, path] = httpMatch;
		const pathSuffix = path || "";
		result = `http://${apiId}.appsync-api.localhost.localstack.cloud:${port}${pathSuffix}`;
	}

	// Handle LocalStack's own format for AppSync Realtime (may lack scheme)
	// Pattern: {api-id}.appsync-realtime-api.localhost.localstack.cloud:4566/...
	// Ensure it has ws:// scheme
	const localstackAppsyncRealtimePattern =
		/^(?:wss?:\/\/)?([a-z0-9]+)\.appsync-realtime-api\.localhost\.localstack\.cloud:(\d+)(\/.*)?$/i;

	const realtimeMatch = result.match(localstackAppsyncRealtimePattern);
	if (realtimeMatch) {
		const [, apiId, port, path] = realtimeMatch;
		const pathSuffix = path || "";
		result = `ws://${apiId}.appsync-realtime-api.localhost.localstack.cloud:${port}${pathSuffix}`;
	}

	return result;
}

/**
 * Transform all URLs in terraform outputs to LocalStack format
 */
export function transformOutputsForLocalStack(
	outputs: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(outputs)) {
		result[key] = transformToLocalStackUrl(value);
	}

	return result;
}

/**
 * Get terraform outputs as JSON
 */
export async function getTerraformOutputs(
	terraformDir: string,
	transformForLocalStack: boolean = true,
): Promise<Record<string, unknown> | null> {
	try {
		const proc = Bun.spawn(["tflocal", "output", "-json"], {
			cwd: terraformDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			return null;
		}

		const stdout = await new Response(proc.stdout).text();
		const outputs: TerraformOutput = JSON.parse(stdout);

		// Extract just the values from the output structure
		const result: Record<string, unknown> = {};
		for (const [key, output] of Object.entries(outputs)) {
			result[key] = output.value;
		}

		// Transform URLs to LocalStack format if requested
		if (transformForLocalStack) {
			return transformOutputsForLocalStack(result);
		}

		return result;
	} catch {
		return null;
	}
}

/**
 * Detect LocalStack availability
 * Returns an object with detection results and reasons
 */
export async function detectLocalStack(): Promise<{
	available: boolean;
	localstackRunning: boolean;
	tfLocalInstalled: boolean;
}> {
	const [localstackRunning, tfLocalInstalled] = await Promise.all([
		isLocalStackRunning(),
		isTfLocalInstalled(),
	]);

	return {
		available: localstackRunning && tfLocalInstalled,
		localstackRunning,
		tfLocalInstalled,
	};
}

/**
 * Live mode configuration extracted from terraform outputs
 */
export interface LiveModeConfig {
	appSyncHttpEndpoint: string;
	appSyncRealtimeEndpoint: string;
	appSyncApiKey: string;
	apiEndpoint: string;
}

/**
 * Get Live mode configuration from terraform outputs
 * Returns the AppSync endpoints needed for dev mode
 */
export async function getLiveModeConfig(
	terraformDir: string,
	transformForLocalStack: boolean = true,
): Promise<LiveModeConfig | null> {
	const outputs = await getTerraformOutputs(terraformDir, transformForLocalStack);

	if (!outputs) {
		return null;
	}

	const httpEndpoint = outputs.appsync_http_endpoint;
	const realtimeEndpoint = outputs.appsync_realtime_endpoint;
	const apiKey = outputs.appsync_api_key;
	const apiEndpoint = outputs.api_endpoint;

	// All required outputs must be present
	if (!httpEndpoint || !realtimeEndpoint || !apiKey) {
		return null;
	}

	return {
		appSyncHttpEndpoint: String(httpEndpoint),
		appSyncRealtimeEndpoint: String(realtimeEndpoint),
		appSyncApiKey: String(apiKey),
		apiEndpoint: apiEndpoint ? String(apiEndpoint) : "",
	};
}

/**
 * Run tflocal apply with dev_mode=true
 */
export async function runTfLocalApplyDevMode(
	terraformDir: string,
): Promise<TfResult> {
	try {
		const proc = Bun.spawn(
			[
				"tflocal",
				"apply",
				"-auto-approve",
				"-input=false",
				"-var=dev_mode=true",
			],
			{
				cwd: terraformDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			const stdout = await new Response(proc.stdout).text();
			return { success: false, error: stderr || stdout };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Check if terraform CLI is installed
 */
export async function isTerraformInstalled(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["terraform", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Run terraform init (for real AWS)
 */
export async function runTerraformInit(
	terraformDir: string,
): Promise<TfResult> {
	try {
		const proc = Bun.spawn(["terraform", "init", "-input=false"], {
			cwd: terraformDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			return { success: false, error: stderr };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Run terraform apply with dev_mode=true (for real AWS)
 */
export async function runTerraformApplyDevMode(
	terraformDir: string,
): Promise<TfResult> {
	try {
		const proc = Bun.spawn(
			[
				"terraform",
				"apply",
				"-auto-approve",
				"-input=false",
				"-var=dev_mode=true",
			],
			{
				cwd: terraformDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			const stdout = await new Response(proc.stdout).text();
			return { success: false, error: stderr || stdout };
		}

		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Get terraform outputs using terraform CLI (for real AWS)
 */
export async function getTerraformOutputsAws(
	terraformDir: string,
): Promise<Record<string, unknown> | null> {
	try {
		const proc = Bun.spawn(["terraform", "output", "-json"], {
			cwd: terraformDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			return null;
		}

		const stdout = await new Response(proc.stdout).text();
		const outputs: TerraformOutput = JSON.parse(stdout);

		// Extract just the values from the output structure
		const result: Record<string, unknown> = {};
		for (const [key, output] of Object.entries(outputs)) {
			result[key] = output.value;
		}

		return result;
	} catch {
		return null;
	}
}

/**
 * Get Live mode configuration from terraform outputs (for real AWS)
 */
export async function getLiveModeConfigAws(
	terraformDir: string,
): Promise<LiveModeConfig | null> {
	const outputs = await getTerraformOutputsAws(terraformDir);

	if (!outputs) {
		return null;
	}

	const httpEndpoint = outputs.appsync_http_endpoint;
	const realtimeEndpoint = outputs.appsync_realtime_endpoint;
	const apiKey = outputs.appsync_api_key;
	const apiEndpoint = outputs.api_endpoint;

	// All required outputs must be present
	if (!httpEndpoint || !realtimeEndpoint || !apiKey) {
		return null;
	}

	return {
		appSyncHttpEndpoint: String(httpEndpoint),
		appSyncRealtimeEndpoint: String(realtimeEndpoint),
		appSyncApiKey: String(apiKey),
		apiEndpoint: apiEndpoint ? String(apiEndpoint) : "",
	};
}
