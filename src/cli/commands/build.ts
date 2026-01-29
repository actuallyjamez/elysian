/**
 * Build command - Production build of all lambdas
 */

import { defineCommand } from "citty";
import { readdirSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config";
import { bundleLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import {
	shouldGenerateOpenApi,
	writeOpenApiLambda,
} from "../../core/openapi";
import { createWrapperEntry } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";
import { ui, pc, formatDuration, formatSize } from "../ui";

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
		ui.header(args.prod ? pc.yellow("production") : "development");

		// Load config
		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			ui.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}

		const name = config.name;
		const lambdasDir = join(process.cwd(), config.lambdasDir);
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);

		// Ensure directories exist
		if (!existsSync(lambdasDir)) {
			ui.error(`Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(terraformDir, { recursive: true });

		// Create temp directory for generated files
		const tempDir = join(outputDir, "__temp__");
		mkdirSync(tempDir, { recursive: true });

		// Get lambda files
		let lambdaFiles = readdirSync(lambdasDir).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("__"),
		);

		if (lambdaFiles.length === 0) {
			ui.warn(`No lambda files found in ${config.lambdasDir}`);
			return;
		}

		// Generate OpenAPI aggregator if enabled
		if (shouldGenerateOpenApi(config)) {
			await writeOpenApiLambda(lambdaFiles, lambdasDir, config, tempDir);
			lambdaFiles.push("__openapi__.ts");
		}

		// Build phase
		ui.success(`Compiling ${lambdaFiles.length} lambdas...`);

		const buildResults: Array<{
			name: string;
			bundleName: string;
			success: boolean;
			error?: string;
		}> = [];

		for (const file of lambdaFiles) {
			const lambdaName = file.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, lambdaName);
			// For OpenAPI, the source is in tempDir; for regular lambdas, it's in lambdasDir
			const inputPath = file === "__openapi__.ts" 
				? join(tempDir, file)
				: join(lambdasDir, file);

			// Create wrapper entry that imports the original and exports handler
			const wrapperPath = join(tempDir, `${lambdaName}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(inputPath);
			await Bun.write(wrapperPath, wrapperContent);

			// Bundle the wrapper with prefixed name
			const result = await bundleLambda(bundleName, wrapperPath, outputDir, config);
			buildResults.push({ ...result, name: lambdaName, bundleName });

			if (!result.success) {
				ui.error(`Failed to build ${lambdaName}: ${result.error}`);
				process.exit(1);
			}
		}

		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });

		// No need to clean up OpenAPI file separately - it's in tempDir

		// Package phase
		ui.success("Packaging lambdas...");

		const packageSizes: Map<string, number> = new Map();

		for (const file of lambdaFiles) {
			const lambdaName = file.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, lambdaName);
			const jsPath = join(outputDir, `${bundleName}.js`);

			const result = await packageLambda(bundleName, jsPath, outputDir);

			if (!result.success) {
				ui.error(`Failed to package ${lambdaName}: ${result.error}`);
				process.exit(1);
			}

			// Get zip size (store by original name for display)
			const zipPath = join(outputDir, `${bundleName}.zip`);
			const stat = await Bun.file(zipPath).stat();
			if (stat) {
				packageSizes.set(lambdaName, stat.size);
			}
		}

		// Generate manifest
		ui.success("Generating manifest...");

		try {
			const manifest = await generateManifest(
				lambdaFiles,
				outputDir,
				config.openapi.enabled,
				name,
			);

			// Write JSON manifest
			const manifestPath = join(outputDir, "manifest.json");
			await writeManifest(manifest, manifestPath);

			// Write Terraform variables
			await writeTerraformVars(manifest, config);

			// Duration
			const duration = Date.now() - startTime;

			// Route table
			ui.section("Routes");

			// Group routes by lambda (use original name for display)
			const routesByLambda = new Map<string, typeof manifest.routes>();
			for (const route of manifest.routes) {
				// Extract display name (original name) from bundle name
				const displayName = route.lambda.startsWith(`${name}-`)
					? route.lambda.slice(name.length + 1)
					: route.lambda;
				const existing = routesByLambda.get(displayName) || [];
				existing.push(route);
				routesByLambda.set(displayName, existing);
			}

			// Find longest path for alignment
			const maxPathLen = Math.max(...manifest.routes.map((r) => r.path.length));

			for (const [displayName, routes] of routesByLambda) {
				const size = packageSizes.get(displayName);
				const sizeStr = size ? formatSize(size) : undefined;
				ui.labeled(displayName, sizeStr);

				for (const route of routes) {
					ui.route(route.method, route.path, route.pathParameters, maxPathLen);
				}
				ui.blank();
			}

			// Summary footer
			ui.divider();

			ui.success(
				`Compiled ${pc.bold(String(manifest.lambdas.length))} lambdas (${manifest.routes.length} routes) in ${pc.bold(formatDuration(duration))}`,
			);
			ui.blank();
		} catch (error) {
			ui.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});
