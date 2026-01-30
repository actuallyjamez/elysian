/**
 * Configuration types and loader for elysian
 */

// =============================================================================
// Sub-config interfaces
// =============================================================================

export interface OpenAPIConfig {
	/** Enable OpenAPI auto-aggregation (default: true) */
	enabled?: boolean;
	/** API title for OpenAPI spec (defaults to name if not provided) */
	title?: string;
	/** API version for OpenAPI spec (defaults to package.json version if not provided) */
	version?: string;
	/** API description for OpenAPI spec */
	description?: string;
}

export interface ApiConfig {
	/** Directory containing API route files (default: "src/api") */
	dir?: string;
	/** OpenAPI configuration */
	openapi?: OpenAPIConfig;
}

export interface FunctionsConfig {
	/** Directory containing function files (default: "src/functions") */
	dir?: string;
}

export interface BuildConfig {
	/** Minify output (default: true in production) */
	minify?: boolean;
	/** Generate sourcemaps (default: true in development) */
	sourcemap?: boolean;
	/** External packages to exclude from bundle (default: ["@aws-sdk/*"]) */
	external?: string[];
}

export interface LambdaConfig {
	/** Lambda runtime (default: "nodejs22.x") */
	runtime?: string;
	/** Lambda memory size in MB (default: 256) */
	memorySize?: number;
	/** Lambda timeout in seconds (default: 30) */
	timeout?: number;
}

export interface TerraformConfig {
	/** Output directory for Terraform files (default: "terraform") */
	outputDir?: string;
	/** Name for the generated API routes tfvars file (default: "api-routes.auto.tfvars") */
	tfvarsFilename?: string;
	/** Name for the generated functions tfvars file (default: "functions.auto.tfvars") */
	functionsTfvarsFilename?: string;
}

// =============================================================================
// Main config interface
// =============================================================================

export interface ElysianConfig {
	/** Name of the API (used for resource naming) */
	name: string;

	/** Output directory for built lambdas (default: "dist") */
	outputDir?: string;

	/** API routes configuration */
	api?: ApiConfig;

	/** Generic functions configuration */
	functions?: FunctionsConfig;

	/** Build configuration */
	build?: BuildConfig;

	/** Lambda defaults (applies to both API routes and functions) */
	lambda?: LambdaConfig;

	/** Terraform configuration */
	terraform?: TerraformConfig;
}

// =============================================================================
// Resolved config (with all defaults applied)
// =============================================================================

export interface ResolvedOpenAPIConfig {
	enabled: boolean;
	title: string;
	version: string;
	description: string;
}

export interface ResolvedApiConfig {
	dir: string;
	openapi: ResolvedOpenAPIConfig;
}

export interface ResolvedFunctionsConfig {
	dir: string;
}

export interface ResolvedBuildConfig {
	minify: boolean;
	sourcemap: boolean;
	external: string[];
}

export interface ResolvedLambdaConfig {
	runtime: string;
	memorySize: number;
	timeout: number;
}

export interface ResolvedTerraformConfig {
	outputDir: string;
	tfvarsFilename: string;
	functionsTfvarsFilename: string;
}

export interface ResolvedConfig {
	name: string;
	outputDir: string;
	api: ResolvedApiConfig;
	functions: ResolvedFunctionsConfig;
	build: ResolvedBuildConfig;
	lambda: ResolvedLambdaConfig;
	terraform: ResolvedTerraformConfig;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_CONFIG = {
	outputDir: "dist",
	api: {
		dir: "src/api",
		openapi: {
			enabled: true,
			title: "API",
			version: "1.0.0",
			description: "",
		},
	},
	functions: {
		dir: "src/functions",
	},
	build: {
		minify: process.env.NODE_ENV === "production",
		sourcemap: process.env.NODE_ENV !== "production",
		external: ["@aws-sdk/*"] as string[],
	},
	lambda: {
		runtime: "nodejs22.x",
		memorySize: 256,
		timeout: 30,
	},
	terraform: {
		outputDir: "terraform",
		tfvarsFilename: "api-routes.auto.tfvars",
		functionsTfvarsFilename: "functions.auto.tfvars",
	},
} as const;

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Read version from package.json
 */
async function readPackageVersion(cwd: string): Promise<string | null> {
	const packagePath = `${cwd}/package.json`;
	try {
		const content = await Bun.file(packagePath).json();
		return content.version || null;
	} catch {
		return null;
	}
}

/**
 * Define configuration with type safety and defaults
 */
export function defineConfig(config: ElysianConfig): ElysianConfig {
	return config;
}

/**
 * Resolve configuration with defaults applied
 */
export async function resolveConfig(
	config: ElysianConfig,
	cwd: string,
): Promise<ResolvedConfig> {
	const pkgVersion = await readPackageVersion(cwd);

	return {
		name: config.name,
		outputDir: config.outputDir ?? DEFAULT_CONFIG.outputDir,
		api: {
			dir: config.api?.dir ?? DEFAULT_CONFIG.api.dir,
			openapi: {
				enabled: config.api?.openapi?.enabled ?? DEFAULT_CONFIG.api.openapi.enabled,
				title: config.api?.openapi?.title ?? config.name,
				version: config.api?.openapi?.version ?? pkgVersion ?? DEFAULT_CONFIG.api.openapi.version,
				description: config.api?.openapi?.description ?? DEFAULT_CONFIG.api.openapi.description,
			},
		},
		functions: {
			dir: config.functions?.dir ?? DEFAULT_CONFIG.functions.dir,
		},
		build: {
			minify: config.build?.minify ?? DEFAULT_CONFIG.build.minify,
			sourcemap: config.build?.sourcemap ?? DEFAULT_CONFIG.build.sourcemap,
			external: config.build?.external ?? DEFAULT_CONFIG.build.external,
		},
		lambda: {
			runtime: config.lambda?.runtime ?? DEFAULT_CONFIG.lambda.runtime,
			memorySize: config.lambda?.memorySize ?? DEFAULT_CONFIG.lambda.memorySize,
			timeout: config.lambda?.timeout ?? DEFAULT_CONFIG.lambda.timeout,
		},
		terraform: {
			outputDir: config.terraform?.outputDir ?? DEFAULT_CONFIG.terraform.outputDir,
			tfvarsFilename: config.terraform?.tfvarsFilename ?? DEFAULT_CONFIG.terraform.tfvarsFilename,
			functionsTfvarsFilename: config.terraform?.functionsTfvarsFilename ?? DEFAULT_CONFIG.terraform.functionsTfvarsFilename,
		},
	};
}

/**
 * Load configuration from elysian.config.ts
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<ResolvedConfig> {
	const configPath = `${cwd}/elysian.config.ts`;

	try {
		const configModule = await import(configPath);
		const config = configModule.default as ElysianConfig;

		if (!config) {
			throw new Error(
				`No default export found in elysian.config.ts\n` +
				`Make sure you have: export default defineConfig({ ... })`,
			);
		}

		if (!config.name) {
			throw new Error(
				`Missing required 'name' property in elysian.config.ts\n` +
				`Add a name: defineConfig({ name: "my-api", ... })`,
			);
		}

		return resolveConfig(config, cwd);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		
		// Config file not found
		if (err.code === "ERR_MODULE_NOT_FOUND") {
			// Check if it's the config file itself or a dependency
			const message = err.message || "";
			if (message.includes("elysian.config")) {
				throw new Error(
					`Configuration file not found: ${configPath}\nRun 'elysian init' to create one.`,
				);
			}
			// Missing dependency in the config file
			throw new Error(
				`Failed to load elysian.config.ts: missing module\n${message}`,
			);
		}

		// Syntax errors
		if (err.name === "SyntaxError") {
			throw new Error(
				`Syntax error in elysian.config.ts:\n${err.message}`,
			);
		}

		// Type errors at runtime
		if (err.name === "TypeError") {
			throw new Error(
				`Type error in elysian.config.ts:\n${err.message}`,
			);
		}

		// Re-throw with more context if it's a generic error
		if (error instanceof Error) {
			throw new Error(
				`Failed to load elysian.config.ts: ${error.message}`,
			);
		}

		throw error;
	}
}
