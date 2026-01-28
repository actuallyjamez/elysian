/**
 * Generate IAC command - Regenerate Terraform files without rebuilding
 */

import { defineCommand } from "citty";
import consola from "consola";
import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "../../core/config";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import { getOriginalLambdaName } from "../../core/naming";

export const generateIacCommand = defineCommand({
	meta: {
		name: "generate-iac",
		description: "Regenerate Terraform files from existing build artifacts",
	},
	args: {},
	async run() {
		consola.start("Loading configuration...");

		let config;
		try {
			config = await loadConfig();
		} catch (error) {
			consola.error(error instanceof Error ? error.message : error);
			process.exit(1);
		}

		const apiName = config.apiName;
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);

		// Check that build output exists
		if (!existsSync(outputDir)) {
			consola.error(
				`Build output directory not found: ${outputDir}\nRun 'elysian build' first.`,
			);
			process.exit(1);
		}

		// Ensure terraform directory exists
		mkdirSync(terraformDir, { recursive: true });

		// Get built lambda files (they have the apiName prefix)
		const jsFiles = readdirSync(outputDir).filter(
			(f) => f.endsWith(".js") && !f.startsWith("__temp__"),
		);

		if (jsFiles.length === 0) {
			consola.error(
				`No built lambda files found in ${outputDir}\nRun 'elysian build' first.`,
			);
			process.exit(1);
		}

		// Convert bundle names back to .ts names for manifest generation
		// The manifest generator will re-add the prefix
		const lambdaFiles = jsFiles.map((f) => {
			const bundleName = f.replace(/\.js$/, "");
			const originalName = getOriginalLambdaName(apiName, bundleName);
			return `${originalName}.ts`;
		});

		consola.info(`Found ${lambdaFiles.length} built lambda(s)`);

		// Generate manifest
		consola.start("Generating route manifest...");

		try {
			const manifest = await generateManifest(
				lambdaFiles,
				outputDir,
				config.openapi.enabled,
				apiName,
			);

			// Write JSON manifest
			const manifestPath = join(outputDir, "manifest.json");
			await writeManifest(manifest, manifestPath);
			consola.success("Generated manifest.json");

			// Write Terraform variables
			const tfvarsPath = await writeTerraformVars(manifest, config);
			consola.success(`Generated ${config.terraform.tfvarsFilename}`);

			// Print summary
			console.log("");
			consola.box(
				`Infrastructure files generated\n\n` +
					`Lambdas: ${manifest.lambdas.length}\n` +
					`Routes:  ${manifest.routes.length}\n\n` +
					`Output: ${config.terraform.outputDir}/${config.terraform.tfvarsFilename}`,
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
