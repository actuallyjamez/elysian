/**
 * Dev command - Watch mode for development
 */

import { defineCommand } from "citty";
import consola from "consola";
import { watch, readdirSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig, type ResolvedConfig } from "../../core/config";
import { bundleLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { createWrapperEntry } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";

export const devCommand = defineCommand({
	meta: {
		name: "dev",
		description: "Watch mode - rebuild lambdas on file changes",
	},
	args: {
		"no-package": {
			type: "boolean",
			description: "Skip creating zip files (faster rebuilds)",
			default: false,
		},
	},
	async run({ args }) {
		consola.start("Loading configuration...");

		let config: ResolvedConfig;
		try {
			config = await loadConfig();
		} catch (error) {
			consola.error(error instanceof Error ? error.message : error);
			process.exit(1);
		}

		const apiName = config.apiName;
		const lambdasDir = join(process.cwd(), config.lambdasDir);
		const outputDir = join(process.cwd(), config.outputDir);
		const tempDir = join(outputDir, "__temp__");

		// Ensure directories exist
		if (!existsSync(lambdasDir)) {
			consola.error(`Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });

		// Get initial lambda files
		const lambdaFiles = readdirSync(lambdasDir).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("__"),
		);

		if (lambdaFiles.length === 0) {
			consola.warn("No lambda files found in", config.lambdasDir);
		}

		// Build function for a single lambda
		async function buildSingleLambda(filename: string): Promise<boolean> {
			const name = filename.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(apiName, name);
			const inputPath = join(lambdasDir, filename);

			// Create wrapper entry
			const wrapperPath = join(tempDir, `${name}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(inputPath);
			await Bun.write(wrapperPath, wrapperContent);

			// Bundle with prefixed name
			const buildResult = await bundleLambda(bundleName, wrapperPath, outputDir, config);

			if (!buildResult.success) {
				consola.error(`Failed to build ${name}: ${buildResult.error}`);
				return false;
			}

			consola.success(`Built ${bundleName}.js`);

			// Package if not disabled
			if (!args["no-package"]) {
				const jsPath = join(outputDir, `${bundleName}.js`);
				const packageResult = await packageLambda(bundleName, jsPath, outputDir);

				if (!packageResult.success) {
					consola.error(`Failed to package ${name}: ${packageResult.error}`);
					return false;
				}

				consola.success(`Packaged ${bundleName}.zip`);
			}

			return true;
		}

		// Initial build of all lambdas
		consola.start("Initial build...");

		for (const file of lambdaFiles) {
			await buildSingleLambda(file);
		}

		consola.info("Initial build complete");
		console.log("");
		consola.box(
			"Watch mode active\n\n" +
				`Watching: ${config.lambdasDir}/\n` +
				`Output:   ${config.outputDir}/\n\n` +
				"Press Ctrl+C to stop",
		);

		// Set up file watcher
		const watcher = watch(lambdasDir, { recursive: false }, async (event, filename) => {
			if (!filename || !filename.endsWith(".ts") || filename.startsWith("__")) {
				return;
			}

			console.log("");
			consola.info(`Change detected: ${filename}`);

			const success = await buildSingleLambda(filename);

			if (success) {
				consola.ready("Rebuild complete");
			}
		});

		// Handle graceful shutdown
		process.on("SIGINT", () => {
			console.log("");
			consola.info("Stopping watcher...");
			watcher.close();

			// Clean up temp directory
			const { rmSync } = require("fs");
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}

			process.exit(0);
		});

		// Keep process alive
		await new Promise(() => {});
	},
});
