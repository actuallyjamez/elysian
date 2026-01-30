/**
 * Generate IAC command - Regenerate Terraform files without rebuilding
 */

import { defineCommand } from "citty";
import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config";
import { generateManifestLegacy, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import { getOriginalLambdaName } from "../../core/naming";
import {
	logger,
	printHeader,
	printSection,
	printDivider,
	printBlank,
	printLambda,
	printRoute,
	printKeyValue,
	formatDuration,
} from "../logger";

export const generateIacCommand = defineCommand({
	meta: {
		name: "generate-iac",
		description: "Regenerate Terraform files from existing build artifacts",
	},
	args: {},
	async run() {
		const startTime = Date.now();

		printHeader();

		// Load config
		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}

		const name = config.name;
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);

		// Check that build output exists
		if (!existsSync(outputDir)) {
			logger.error(`Build output directory not found: ${outputDir}`);
			logger.info("Run 'elysian build' first");
			process.exit(1);
		}

		// Ensure terraform directory exists
		mkdirSync(terraformDir, { recursive: true });

		// Get built lambda files (they have the apiName prefix)
		const jsFiles = readdirSync(outputDir).filter(
			(f) => f.endsWith(".js") && !f.startsWith("__temp__"),
		);

		if (jsFiles.length === 0) {
			logger.error(`No built lambda files found in ${outputDir}`);
			logger.info("Run 'elysian build' first");
			process.exit(1);
		}

		// Convert bundle names back to .ts names for manifest generation
		// The manifest generator will re-add the prefix
		const lambdaFiles = jsFiles.map((f) => {
			const bundleName = f.replace(/\.js$/, "");
			const originalName = getOriginalLambdaName(name, bundleName);
			return `${originalName}.ts`;
		});

		logger.success(`Found ${lambdaFiles.length} built lambda${lambdaFiles.length === 1 ? "" : "s"}`);

		// Generate manifest
		logger.info("Generating route manifest...");

		try {
			const manifest = await generateManifestLegacy(
				lambdaFiles,
				outputDir,
				config.api.openapi.enabled,
				name,
			);

			// Write JSON manifest
			const manifestPath = join(outputDir, "manifest.json");
			await writeManifest(manifest, manifestPath);
			logger.success("Generated manifest.json");

			// Write Terraform variables
			await writeTerraformVars(manifest, config);
			logger.success(`Generated ${config.terraform.tfvarsFilename}`);

			// Route table
			printSection("Routes");

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

			// Find longest path for alignment
			const maxPathLen = Math.max(...manifest.routes.map((r) => r.path.length));

			for (const [displayName, routes] of routesByLambda) {
				printLambda(displayName);
				for (const route of routes) {
					printRoute(route.method, route.path, route.pathParameters, maxPathLen);
				}
				printBlank();
			}

			// Summary
			printDivider();

			const duration = Date.now() - startTime;
			logger.success(
				`Generated infrastructure for \x1b[1m${manifest.lambdas.length}\x1b[0m lambdas (${manifest.routes.length} routes) in \x1b[1m${formatDuration(duration)}\x1b[0m`,
			);
			printBlank();
			printKeyValue("Output", `${config.terraform.outputDir}/${config.terraform.tfvarsFilename}`);
			printBlank();
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	},
});
