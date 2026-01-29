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
 */
export function transformToLocalStackUrl(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}

	// Match API Gateway URLs: https://{api-id}.execute-api.{region}.amazonaws.com
	const apiGatewayPattern =
		/https:\/\/([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(\/.*)?/gi;

	return value.replace(apiGatewayPattern, (match, apiId, region, path) => {
		const pathSuffix = path || "";
		return `http://${apiId}.execute-api.localhost.localstack.cloud:4566${pathSuffix}`;
	});
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
