/**
 * Build command - Production build of all lambdas
 */

import { defineCommand } from "citty";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config";
import {
	bundleApiRoute,
	bundleGenericLambda,
	type BundleResult,
} from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import {
	shouldGenerateOpenApi,
	writeOpenApiLambda,
} from "../../core/openapi";
import { createWrapperEntry, createGenericLambdaWrapper } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";
import {
	discoverLambdas,
	validateExport,
	hasApiRoutes,
	hasGenericLambdas,
	type DiscoveredApiRoute,
	type DiscoveredLambda,
} from "../../core/discovery";
import {
	logger,
	printHeader,
	printSection,
	printDivider,
	printBlank,
	printLambda,
	printRoute,
	formatDuration,
	formatSize,
} from "../logger";

export const buildCommand = defineCommand({
	meta: {
		name: "build",
		description: "Build all lambdas for production deployment",
	},
	args: {
		prod: {
			type: "boolean",
			description: "Production build (minify, no sourcemaps)",
			default: false,
		},
	},
	async run({ args }) {
		const startTime = Date.now();

		// Set production mode if flag is set
		if (args.prod) {
			process.env.NODE_ENV = "production";
		}

		// Header
		printHeader(args.prod ? "\x1b[33mproduction\x1b[0m" : "development");

		// Load config
		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}

		const cwd = process.cwd();
		const name = config.name;
		const outputDir = join(cwd, config.outputDir);
		const terraformDir = join(cwd, config.terraform.outputDir);

		// Ensure output directories exist
		mkdirSync(outputDir, { recursive: true });
		mkdirSync(terraformDir, { recursive: true });

		// Discover lambdas in both directories
		const discovered = await discoverLambdas(cwd, config, (filename, reason) => {
			logger.warn(`Skipping ${filename}: ${reason}`);
		});

		// Check if we have anything to build
		if (discovered.apiRoutes.length === 0 && discovered.functions.length === 0) {
			logger.warn(`No lambda files found in ${config.api.dir} or ${config.functions.dir}`);
			return;
		}

		// Create temp directory for generated files
		const tempDir = join(outputDir, "__temp__");
		mkdirSync(tempDir, { recursive: true });

		// Track all build results
		const allBuildResults: BundleResult[] = [];
		const packageSizes = new Map<string, number>();

		// =====================
		// Build API Routes
		// =====================
		if (discovered.apiRoutes.length > 0) {
			printSection("API Routes");
			logger.success(`Compiling ${discovered.apiRoutes.length} API routes from ${config.api.dir}...`);

			// Generate OpenAPI aggregator if enabled
			let apiRoutesWithOpenApi = [...discovered.apiRoutes];
			if (shouldGenerateOpenApi(config)) {
				const openApiPath = await writeOpenApiLambda(discovered.apiRoutes, config, tempDir);
				const openApiRoute: DiscoveredApiRoute = {
					name: "openapi",
					sourcePath: openApiPath,
					bundleName: getLambdaBundleName(name, "openapi"),
				};
				apiRoutesWithOpenApi.push(openApiRoute);
			}

			for (const route of apiRoutesWithOpenApi) {
				// Create wrapper entry that imports the original and exports handler
				const wrapperPath = join(tempDir, `${route.name}-wrapper.ts`);
				const wrapperContent = createWrapperEntry(route.sourcePath);
				await Bun.write(wrapperPath, wrapperContent);

				// Bundle the wrapper
				const result = await bundleApiRoute(
					{ ...route, sourcePath: wrapperPath },
					outputDir,
					config,
				);
				allBuildResults.push(result);

				if (!result.success) {
					logger.error(`Failed to build ${route.name}: ${result.error}`);
					process.exit(1);
				}
			}

			// Validate exports (skip openapi which is auto-generated)
			for (const route of discovered.apiRoutes) {
				const bundlePath = join(outputDir, `${route.bundleName}.js`);
				const validationError = await validateExport(bundlePath, "routes", route.sourcePath);
				if (validationError) {
					logger.error(validationError.message);
					process.exit(1);
				}
			}
		}

		// =====================
		// Build Generic Functions
		// =====================
		if (discovered.functions.length > 0) {
			printSection("Generic Functions");
			logger.success(`Compiling ${discovered.functions.length} generic functions from ${config.functions.dir}...`);

			for (const fn of discovered.functions) {
				// Create wrapper that extracts handler from defineLambda export
				const wrapperPath = join(tempDir, `${fn.name}-lambda-wrapper.ts`);
				const wrapperContent = createGenericLambdaWrapper(fn.sourcePath);
				await Bun.write(wrapperPath, wrapperContent);

				// Bundle the wrapper
				const result = await bundleGenericLambda(
					{ ...fn, sourcePath: wrapperPath },
					outputDir,
					config,
				);
				allBuildResults.push(result);

				if (!result.success) {
					logger.error(`Failed to build ${fn.name}: ${result.error}`);
					process.exit(1);
				}
			}

			// Validate exports
			for (const fn of discovered.functions) {
				const bundlePath = join(outputDir, `${fn.bundleName}.js`);
				const validationError = await validateExport(bundlePath, "lambda", fn.sourcePath);
				if (validationError) {
					logger.error(validationError.message);
					process.exit(1);
				}
			}
		}

		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });

		// =====================
		// Package Phase
		// =====================
		printSection("Packaging");
		logger.success("Packaging lambdas...");

		for (const result of allBuildResults) {
			if (!result.success) continue;

			const jsPath = join(outputDir, `${result.bundleName}.js`);
			const packageResult = await packageLambda(result.bundleName, jsPath, outputDir);

			if (!packageResult.success) {
				logger.error(`Failed to package ${result.name}: ${packageResult.error}`);
				process.exit(1);
			}

			// Get zip size
			const zipPath = join(outputDir, `${result.bundleName}.zip`);
			const stat = await Bun.file(zipPath).stat();
			if (stat) {
				packageSizes.set(result.name, stat.size);
			}
		}

		// =====================
		// Generate Manifest
		// =====================
		printSection("Manifest");
		logger.success("Generating manifest...");

		try {
			const manifest = await generateManifest(
				discovered.apiRoutes,
				discovered.functions,
				outputDir,
				config.api.openapi.enabled,
				name,
			);

			// Write JSON manifest
			const manifestPath = join(outputDir, "manifest.json");
			await writeManifest(manifest, manifestPath);

			// Write Terraform variables (both files)
			await writeTerraformVars(manifest, config);

			// Duration
			const duration = Date.now() - startTime;

			// =====================
			// Output Summary
			// =====================
			
			// API Routes table
			if (manifest.routes.length > 0) {
				printSection("API Routes");

				// Group routes by lambda
				const routesByLambda = new Map<string, typeof manifest.routes>();
				for (const route of manifest.routes) {
					const displayName = route.lambda.startsWith(`${name}-`)
						? route.lambda.slice(name.length + 1)
						: route.lambda;
					const existing = routesByLambda.get(displayName) || [];
					existing.push(route);
					routesByLambda.set(displayName, existing);
				}

				const maxPathLen = Math.max(...manifest.routes.map((r) => r.path.length));

				for (const [displayName, routes] of routesByLambda) {
					const size = packageSizes.get(displayName);
					const sizeStr = size ? formatSize(size) : undefined;
					printLambda(displayName, sizeStr);

					for (const route of routes) {
						printRoute(route.method, route.path, route.pathParameters, maxPathLen);
					}
					printBlank();
				}
			}

			// Generic Lambdas table
			if (manifest.genericLambdas.length > 0) {
				printSection("Functions");

				for (const lambda of manifest.genericLambdas) {
					const size = packageSizes.get(lambda.name);
					const sizeStr = size ? formatSize(size) : undefined;
					
					let triggerStr: string;
					if (lambda.trigger?.type) {
						const triggerType = lambda.trigger.type;
						// Show schedule duration if available
						if (triggerType === "schedule" && lambda.trigger.config && "every" in lambda.trigger.config) {
							triggerStr = `\x1b[90m[${triggerType}: ${lambda.trigger.config.every}]\x1b[0m`;
						} else {
							triggerStr = `\x1b[90m[${triggerType}]\x1b[0m`;
						}
					} else {
						triggerStr = "\x1b[90m[manual]\x1b[0m";
					}
					
					printLambda(`${lambda.name} ${triggerStr}`, sizeStr);
				}
				printBlank();
			}

			// Summary footer
			printDivider();

			const totalLambdas = manifest.lambdas.length + manifest.genericLambdas.length;
			const routeCount = manifest.routes.length;
			const parts = [];
			
			if (manifest.lambdas.length > 0) {
				parts.push(`${manifest.lambdas.length} API routes`);
			}
			if (manifest.genericLambdas.length > 0) {
				parts.push(`${manifest.genericLambdas.length} functions`);
			}

			logger.success(
				`Compiled \x1b[1m${totalLambdas}\x1b[0m lambdas (${parts.join(", ")}) in \x1b[1m${formatDuration(duration)}\x1b[0m`,
			);
			printBlank();
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});
