/**
 * Build command - Production build of all lambdas
 */

import { defineCommand } from "citty";
import { readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import pc from "picocolors";
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
import { getLambdaBundleName } from "../../core/naming";
import { version } from "../../core/version";

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
		console.log();
		console.log(
			`  ${pc.bold(pc.cyan("elysian"))} ${pc.dim(`v${version}`)} ${args.prod ? pc.yellow("production") : pc.dim("development")}`,
		);
		console.log();

		// Load config
		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			console.log(
				`  ${pc.red("✗")} ${error instanceof Error ? error.message : error}`,
			);
			process.exit(1);
		}

		const name = config.name;
		const lambdasDir = join(process.cwd(), config.lambdasDir);
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);

		// Ensure directories exist
		if (!existsSync(lambdasDir)) {
			console.log(`  ${pc.red("✗")} Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(terraformDir, { recursive: true });

		// Get lambda files
		let lambdaFiles = readdirSync(lambdasDir).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("__"),
		);

		if (lambdaFiles.length === 0) {
			console.log(`  ${pc.yellow("!")} No lambda files found in ${config.lambdasDir}`);
			return;
		}

		// Generate OpenAPI aggregator if enabled
		if (shouldGenerateOpenApi(config)) {
			await writeOpenApiLambda(lambdaFiles, lambdasDir, config);
			lambdaFiles.push("__openapi__.ts");
		}

		// Build phase
		console.log(`  ${pc.green("✓")} Compiling ${lambdaFiles.length} lambdas...`);

		const tempDir = join(outputDir, "__temp__");
		mkdirSync(tempDir, { recursive: true });

		const buildResults: Array<{ name: string; bundleName: string; success: boolean; error?: string }> =
			[];

		for (const file of lambdaFiles) {
			const name = file.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, name);
			const inputPath = join(lambdasDir, file);

			// Create wrapper entry that imports the original and exports handler
			const wrapperPath = join(tempDir, `${name}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(inputPath);
			await Bun.write(wrapperPath, wrapperContent);

			// Bundle the wrapper with prefixed name
			const result = await bundleLambda(bundleName, wrapperPath, outputDir, config);
			buildResults.push({ ...result, name, bundleName });

			if (!result.success) {
				console.log(`  ${pc.red("✗")} Failed to build ${name}: ${result.error}`);
				process.exit(1);
			}
		}

		// Clean up temp directory
		const { rmSync } = await import("fs");
		rmSync(tempDir, { recursive: true, force: true });

		// Clean up generated OpenAPI file
		if (shouldGenerateOpenApi(config)) {
			await cleanupOpenApiLambda(lambdasDir);
		}

		// Package phase
		console.log(`  ${pc.green("✓")} Packaging lambdas...`);

		const packageSizes: Map<string, number> = new Map();

		for (const file of lambdaFiles) {
			const name = file.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, name);
			const jsPath = join(outputDir, `${bundleName}.js`);

			const result = await packageLambda(bundleName, jsPath, outputDir);

			if (!result.success) {
				console.log(`  ${pc.red("✗")} Failed to package ${name}: ${result.error}`);
				process.exit(1);
			}

			// Get zip size (store by original name for display)
			const zipPath = join(outputDir, `${bundleName}.zip`);
			const stat = await Bun.file(zipPath).stat();
			if (stat) {
				packageSizes.set(name, stat.size);
			}
		}

		// Generate manifest
		console.log(`  ${pc.green("✓")} Generating manifest...`);

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

			// Route table header
			console.log();
			console.log(`  ${pc.bold("Routes")}`);
			console.log();

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

			// Method colors
			const methodColor = (method: string) => {
				switch (method) {
					case "GET":
						return pc.green;
					case "POST":
						return pc.blue;
					case "PUT":
						return pc.yellow;
					case "DELETE":
						return pc.red;
					case "PATCH":
						return pc.magenta;
					default:
						return pc.white;
				}
			};

			// Find longest path for alignment
			const maxPathLen = Math.max(...manifest.routes.map((r) => r.path.length));

			for (const [displayName, routes] of routesByLambda) {
				const size = packageSizes.get(displayName);
				const sizeStr = size ? pc.dim(` (${formatSize(size)})`) : "";
				console.log(`  ${pc.dim("λ")} ${pc.bold(displayName)}${sizeStr}`);

				for (const route of routes) {
					const method = methodColor(route.method)(route.method.padEnd(6));
					const path = route.path.padEnd(maxPathLen + 2);
					const params =
						route.pathParameters.length > 0
							? pc.dim(` [${route.pathParameters.join(", ")}]`)
							: "";
					console.log(`    ${method} ${path}${params}`);
				}
				console.log();
			}

			// Summary footer
			console.log(pc.dim("  " + "─".repeat(40)));
			console.log();
			console.log(
				`  ${pc.green("✓")} Compiled ${pc.bold(String(manifest.lambdas.length))} lambdas (${manifest.routes.length} routes) in ${pc.bold(formatDuration(duration))}`,
			);
			console.log();
		} catch (error) {
			console.log(
				`  ${pc.red("✗")} ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		}
	},
});
