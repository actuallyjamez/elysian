/**
 * Build command - Production build of all lambdas
 */

import { defineCommand } from "citty";
import consola from "consola";
import { readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config";
import { bundleLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import {
	shouldGenerateOpenApi,
	writeOpenApiLambda,
	cleanupOpenApiLambda,
} from "../../core/openapi";
import { createWrapperEntry } from "../../core/handler-wrapper";

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

		consola.start("Loading configuration...");

		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			consola.error(error instanceof Error ? error.message : error);
			process.exit(1);
		}

		const lambdasDir = join(process.cwd(), config.lambdasDir);
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);

		// Ensure directories exist
		if (!existsSync(lambdasDir)) {
			consola.error(`Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(terraformDir, { recursive: true });

		// Get lambda files
		let lambdaFiles = readdirSync(lambdasDir).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("__"),
		);

		if (lambdaFiles.length === 0) {
			consola.warn("No lambda files found in", config.lambdasDir);
			return;
		}

		consola.info(`Found ${lambdaFiles.length} lambda(s) to build`);

		// Generate OpenAPI aggregator if enabled
		if (shouldGenerateOpenApi(config)) {
			consola.start("Generating OpenAPI aggregator...");
			await writeOpenApiLambda(lambdaFiles, lambdasDir, config);
			lambdaFiles.push("__openapi__.ts");
		}

		// Build each lambda
		consola.start("Bundling lambdas...");

		const tempDir = join(outputDir, "__temp__");
		mkdirSync(tempDir, { recursive: true });

		const buildResults: Array<{ name: string; success: boolean; error?: string }> = [];

		for (const file of lambdaFiles) {
			const name = file.replace(/\.ts$/, "");
			const inputPath = join(lambdasDir, file);

			// Create wrapper entry that imports the original and exports handler
			const wrapperPath = join(tempDir, `${name}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(inputPath);
			await Bun.write(wrapperPath, wrapperContent);

			// Bundle the wrapper
			const result = await bundleLambda(name, wrapperPath, outputDir, config);

			if (result.success) {
				consola.success(`Built ${name}.js`);
			} else {
				consola.error(`Failed to build ${name}: ${result.error}`);
			}

			buildResults.push(result);
		}

		// Clean up temp directory
		const { rmSync } = await import("fs");
		rmSync(tempDir, { recursive: true, force: true });

		// Clean up generated OpenAPI file
		if (shouldGenerateOpenApi(config)) {
			await cleanupOpenApiLambda(lambdasDir);
		}

		// Check for build failures
		const failures = buildResults.filter((r) => !r.success);
		if (failures.length > 0) {
			consola.error(`${failures.length} lambda(s) failed to build`);
			process.exit(1);
		}

		// Package each lambda into zip
		consola.start("Packaging lambdas...");

		for (const file of lambdaFiles) {
			const name = file.replace(/\.ts$/, "");
			const jsPath = join(outputDir, `${name}.js`);
			const result = await packageLambda(name, jsPath, outputDir);

			if (result.success) {
				consola.success(`Packaged ${name}.zip`);
			} else {
				consola.error(`Failed to package ${name}: ${result.error}`);
				process.exit(1);
			}
		}

		// Generate manifest
		consola.start("Generating route manifest...");

		try {
			const manifest = await generateManifest(
				lambdaFiles,
				outputDir,
				config.openapi.enabled,
			);

			// Write JSON manifest
			const manifestPath = join(outputDir, "manifest.json");
			await writeManifest(manifest, manifestPath);
			consola.success("Generated manifest.json");

			// Write Terraform variables
			const tfvarsPath = await writeTerraformVars(manifest, config);
			consola.success(`Generated ${config.terraform.tfvarsFilename}`);

			// Print summary
			const duration = ((Date.now() - startTime) / 1000).toFixed(2);
			console.log("");
			consola.box(
				`Build complete in ${duration}s\n\n` +
					`Lambdas: ${manifest.lambdas.length}\n` +
					`Routes:  ${manifest.routes.length}\n\n` +
					`Output:  ${config.outputDir}/\n` +
					`Terraform: ${config.terraform.outputDir}/${config.terraform.tfvarsFilename}`,
			);

			// Print route summary
			console.log("\nRoute Summary:");
			for (const route of manifest.routes) {
				const params =
					route.pathParameters.length > 0
						? ` [${route.pathParameters.join(", ")}]`
						: "";
				console.log(
					`  ${route.method.padEnd(6)} ${route.path.padEnd(30)} → ${route.lambda}${params}`,
				);
			}
		} catch (error) {
			consola.error(error instanceof Error ? error.message : error);
			process.exit(1);
		}
	},
});
