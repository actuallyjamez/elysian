/**
 * Configuration types and loader for elysian
 */

export interface OpenAPIConfig {
	/** Enable OpenAPI auto-aggregation (default: true) */
	enabled?: boolean;
	/** API title for OpenAPI spec */
	title?: string;
	/** API version for OpenAPI spec */
	version?: string;
	/** API description for OpenAPI spec */
	description?: string;
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
	/** Name for the generated tfvars file (default: "api-routes.auto.tfvars") */
	tfvarsFilename?: string;
}

export interface ElysianConfig {
	/** Name of the API (used for resource naming) */
	apiName: string;

	/** Directory containing lambda files (default: "src/lambdas") */
	lambdasDir?: string;

	/** Output directory for built lambdas (default: "dist") */
	outputDir?: string;

	/** OpenAPI configuration */
	openapi?: OpenAPIConfig;

	/** Build configuration */
	build?: BuildConfig;

	/** Lambda defaults */
	lambda?: LambdaConfig;

	/** Terraform configuration */
	terraform?: TerraformConfig;
}

export interface ResolvedConfig {
	apiName: string;
	lambdasDir: string;
	outputDir: string;
	openapi: Required<OpenAPIConfig>;
	build: Required<BuildConfig>;
	lambda: Required<LambdaConfig>;
	terraform: Required<TerraformConfig>;
}

const DEFAULT_CONFIG: Omit<ResolvedConfig, "apiName"> = {
	lambdasDir: "src/lambdas",
	outputDir: "dist",
	openapi: {
		enabled: true,
		title: "API",
		version: "1.0.0",
		description: "",
	},
	build: {
		minify: process.env.NODE_ENV === "production",
		sourcemap: process.env.NODE_ENV !== "production",
		external: ["@aws-sdk/*"],
	},
	lambda: {
		runtime: "nodejs22.x",
		memorySize: 256,
		timeout: 30,
	},
	terraform: {
		outputDir: "terraform",
		tfvarsFilename: "api-routes.auto.tfvars",
	},
};

/**
 * Define configuration with type safety and defaults
 */
export function defineConfig(config: ElysianConfig): ElysianConfig {
	return config;
}

/**
 * Resolve configuration with defaults applied
 */
export function resolveConfig(config: ElysianConfig): ResolvedConfig {
	return {
		apiName: config.apiName,
		lambdasDir: config.lambdasDir ?? DEFAULT_CONFIG.lambdasDir,
		outputDir: config.outputDir ?? DEFAULT_CONFIG.outputDir,
		openapi: {
			enabled: config.openapi?.enabled ?? DEFAULT_CONFIG.openapi.enabled,
			title: config.openapi?.title ?? DEFAULT_CONFIG.openapi.title,
			version: config.openapi?.version ?? DEFAULT_CONFIG.openapi.version,
			description:
				config.openapi?.description ?? DEFAULT_CONFIG.openapi.description,
		},
		build: {
			minify: config.build?.minify ?? DEFAULT_CONFIG.build.minify,
			sourcemap: config.build?.sourcemap ?? DEFAULT_CONFIG.build.sourcemap,
			external: config.build?.external ?? DEFAULT_CONFIG.build.external,
		},
		lambda: {
			runtime: config.lambda?.runtime ?? DEFAULT_CONFIG.lambda.runtime,
			memorySize:
				config.lambda?.memorySize ?? DEFAULT_CONFIG.lambda.memorySize,
			timeout: config.lambda?.timeout ?? DEFAULT_CONFIG.lambda.timeout,
		},
		terraform: {
			outputDir:
				config.terraform?.outputDir ?? DEFAULT_CONFIG.terraform.outputDir,
			tfvarsFilename:
				config.terraform?.tfvarsFilename ??
				DEFAULT_CONFIG.terraform.tfvarsFilename,
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

		if (!config.apiName) {
			throw new Error("apiName is required in elysian.config.ts");
		}

		return resolveConfig(config);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
			throw new Error(
				`Configuration file not found: ${configPath}\nRun 'elysian init' to create one.`,
			);
		}
		throw error;
	}
}
