/**
 * Dev command - Watch mode with LocalStack integration
 */

import { defineCommand } from "citty";
import { watch, readdirSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { loadConfig, type ResolvedConfig } from "../../core/config";
import { bundleLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { createWrapperEntry } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import {
	shouldGenerateOpenApi,
	writeOpenApiLambda,
	cleanupOpenApiLambda,
} from "../../core/openapi";
import {
	detectLocalStack,
	isTerraformInitialized,
	runTfLocalInit,
	runTfLocalApply,
	getTerraformOutputs,
} from "../../core/localstack";
import { ui, pc, createSpinner, formatDuration } from "../ui";

export const devCommand = defineCommand({
	meta: {
		name: "dev",
		description: "Watch mode - rebuild lambdas on file changes with LocalStack deploy",
	},
	args: {
		"no-package": {
			type: "boolean",
			description: "Skip creating zip files (faster rebuilds)",
			default: false,
		},
		"no-localstack": {
			type: "boolean",
			description: "Disable LocalStack integration",
			default: false,
		},
	},
	async run({ args }) {
		// Initial setup
		ui.header(pc.dim("dev"));

		// Load config
		let config: ResolvedConfig;
		try {
			config = await loadConfig();
			ui.success("Loaded configuration");
		} catch (error) {
			ui.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}

		const name = config.name;
		const lambdasDir = join(process.cwd(), config.lambdasDir);
		const outputDir = join(process.cwd(), config.outputDir);
		const terraformDir = join(process.cwd(), config.terraform.outputDir);
		const tempDir = join(outputDir, "__temp__");

		// Ensure directories exist
		if (!existsSync(lambdasDir)) {
			ui.error(`Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });

		// Detect LocalStack
		let localstackEnabled = false;

		if (!args["no-localstack"]) {
			const detection = await detectLocalStack();

			if (detection.available) {
				localstackEnabled = true;
				ui.success("LocalStack detected");

				// Check if terraform is initialized
				if (!isTerraformInitialized(terraformDir)) {
					const spinner = createSpinner("Initializing terraform...").start();
					const initResult = await runTfLocalInit(terraformDir);
					if (!initResult.success) {
						spinner.fail("tflocal init failed");
						console.log(pc.dim(initResult.error));
						ui.warn("Continuing without LocalStack deploy");
						localstackEnabled = false;
					} else {
						spinner.succeed("Terraform initialized");
					}
				}
			} else {
				if (!detection.localstackRunning) {
					ui.warn("LocalStack not running - skipping deploy");
				}
				if (!detection.tfLocalInstalled) {
					ui.warn("tflocal not installed - skipping deploy");
				}
			}
		}

		// Get initial lambda files
		let lambdaFiles = readdirSync(lambdasDir).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("__"),
		);

		if (lambdaFiles.length === 0) {
			ui.warn(`No lambda files found in ${config.lambdasDir}`);
		}

		// Track last terraform outputs and build info for display
		let lastOutputs: Record<string, unknown> | null = null;
		let lastBuildInfo: { lambdas: number; routes: number; duration: number } | null = null;
		let lastError: string | null = null;

		// Build function for a single lambda
		async function buildSingleLambda(filename: string): Promise<boolean> {
			const lambdaName = filename.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, lambdaName);
			const inputPath = join(lambdasDir, filename);

			// Create wrapper entry
			const wrapperPath = join(tempDir, `${lambdaName}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(inputPath);
			await Bun.write(wrapperPath, wrapperContent);

			// Bundle with prefixed name
			const buildResult = await bundleLambda(
				bundleName,
				wrapperPath,
				outputDir,
				config,
			);

			if (!buildResult.success) {
				return false;
			}

			// Package if not disabled
			if (!args["no-package"]) {
				const jsPath = join(outputDir, `${bundleName}.js`);
				const packageResult = await packageLambda(bundleName, jsPath, outputDir);

				if (!packageResult.success) {
					return false;
				}
			}

			return true;
		}

		// Build all lambdas (including OpenAPI if enabled)
		async function buildAll(): Promise<{ success: boolean; count: number; error?: string }> {
			// Refresh lambda file list
			lambdaFiles = readdirSync(lambdasDir).filter(
				(f) => f.endsWith(".ts") && !f.startsWith("__"),
			);

			const filesToBuild = [...lambdaFiles];

			// Generate OpenAPI aggregator if enabled
			if (shouldGenerateOpenApi(config)) {
				await writeOpenApiLambda(lambdaFiles, lambdasDir, config);
				filesToBuild.push("__openapi__.ts");
			}

			// Build all lambdas
			for (const file of filesToBuild) {
				const success = await buildSingleLambda(file);
				if (!success) {
					return { success: false, count: 0, error: `Failed to build ${file}` };
				}
			}

			// Cleanup OpenAPI source file
			if (shouldGenerateOpenApi(config)) {
				await cleanupOpenApiLambda(lambdasDir);
			}

			return { success: true, count: filesToBuild.length };
		}

		// Generate manifest and terraform vars
		async function generateManifestFiles(): Promise<{ success: boolean; routes: number; error?: string }> {
			try {
				const filesToManifest = [...lambdaFiles];
				if (shouldGenerateOpenApi(config)) {
					filesToManifest.push("__openapi__.ts");
				}

				const manifest = await generateManifest(
					filesToManifest,
					outputDir,
					config.openapi.enabled,
					name,
				);

				const manifestPath = join(outputDir, "manifest.json");
				await writeManifest(manifest, manifestPath);
				await writeTerraformVars(manifest, config);

				return { success: true, routes: manifest.routes.length };
			} catch (err) {
				return { success: false, routes: 0, error: err instanceof Error ? err.message : String(err) };
			}
		}

		// Deploy to LocalStack
		async function deployToLocalStack(): Promise<{ success: boolean; error?: string }> {
			const applyResult = await runTfLocalApply(terraformDir);

			if (!applyResult.success) {
				return { success: false, error: applyResult.error };
			}

			// Get and store outputs (transformed to LocalStack URLs)
			lastOutputs = await getTerraformOutputs(terraformDir, true);

			return { success: true };
		}

		// Show the final status screen (Vite-like)
		function showReadyScreen(trigger?: string, failed?: boolean): void {
			ui.clear();
			ui.header(pc.dim("dev"));

			if (failed) {
				ui.error("Build failed");
				if (trigger) {
					ui.info(`Triggered by: ${trigger}`);
				}
				if (lastError) {
					ui.blank();
					console.log(pc.dim("  Error:"));
					// Show first few lines of error
					const errorLines = lastError.split("\n").slice(0, 10);
					for (const line of errorLines) {
						console.log(pc.red(`  ${line}`));
					}
					if (lastError.split("\n").length > 10) {
						console.log(pc.dim("  ... (truncated)"));
					}
				}
			} else if (lastBuildInfo) {
				ui.success(
					`Ready in ${pc.bold(formatDuration(lastBuildInfo.duration))}`,
				);
				ui.blank();

				// Show outputs prominently
				if (lastOutputs && Object.keys(lastOutputs).length > 0) {
					for (const [key, value] of Object.entries(lastOutputs)) {
						const valueStr = typeof value === "string" ? value : JSON.stringify(value);
						console.log(`  ${pc.dim("➜")}  ${pc.bold(key)}: ${pc.cyan(valueStr)}`);
					}
				}

				ui.blank();
				console.log(
					pc.dim(`  ${lastBuildInfo.lambdas} lambda${lastBuildInfo.lambdas === 1 ? "" : "s"} · ${lastBuildInfo.routes} routes`),
				);
			}

			// Watch status
			ui.blank();
			console.log(pc.dim("  ─────────────────────────────────────"));
			ui.blank();

			const watchDirs = [config.lambdasDir];
			if (localstackEnabled) {
				watchDirs.push(config.terraform.outputDir);
			}

			console.log(`  ${pc.dim("watching:")} ${watchDirs.join(", ")}`);

			if (localstackEnabled) {
				console.log(`  ${pc.dim("deploy:")}   ${pc.green("localstack")}`);
			}

			ui.blank();
			console.log(pc.dim("  press ctrl+c to stop"));
			ui.blank();
		}

		// Run the full build and deploy cycle
		async function runBuildCycle(trigger?: string): Promise<void> {
			const cycleStart = Date.now();
			lastError = null;

			// Show building status
			ui.clear();
			ui.header(pc.dim("dev"));

			if (trigger) {
				ui.info(`Change: ${trigger}`);
				ui.blank();
			}

			// Build
			const buildSpinner = createSpinner("Building...").start();
			const buildResult = await buildAll();

			if (!buildResult.success) {
				buildSpinner.fail("Build failed");
				lastError = buildResult.error || "Unknown build error";
				showReadyScreen(trigger, true);
				return;
			}

			buildSpinner.succeed(`Built ${buildResult.count} lambda${buildResult.count === 1 ? "" : "s"}`);

			// Generate manifest
			const manifestSpinner = createSpinner("Generating manifest...").start();
			const manifestResult = await generateManifestFiles();

			if (!manifestResult.success) {
				manifestSpinner.fail("Manifest failed");
				lastError = manifestResult.error || "Unknown manifest error";
				showReadyScreen(trigger, true);
				return;
			}

			manifestSpinner.succeed("Generated manifest");

			// Deploy if LocalStack enabled
			if (localstackEnabled) {
				const deploySpinner = createSpinner("Deploying...").start();
				const deployResult = await deployToLocalStack();

				if (!deployResult.success) {
					deploySpinner.fail("Deploy failed");
					lastError = deployResult.error || "Unknown deploy error";
					showReadyScreen(trigger, true);
					return;
				}

				deploySpinner.succeed("Deployed");
			}

			// Store build info
			const duration = Date.now() - cycleStart;
			lastBuildInfo = {
				lambdas: buildResult.count,
				routes: manifestResult.routes,
				duration,
			};

			// Show ready screen
			showReadyScreen(trigger);
		}

		// Run terraform-only deploy
		async function runTerraformCycle(trigger: string): Promise<void> {
			const cycleStart = Date.now();
			lastError = null;

			ui.clear();
			ui.header(pc.dim("dev"));
			ui.info(`Terraform: ${trigger}`);
			ui.blank();

			const deploySpinner = createSpinner("Deploying...").start();
			const deployResult = await deployToLocalStack();

			if (!deployResult.success) {
				deploySpinner.fail("Deploy failed");
				lastError = deployResult.error || "Unknown deploy error";
				showReadyScreen(trigger, true);
				return;
			}

			deploySpinner.succeed("Deployed");

			// Update duration
			if (lastBuildInfo) {
				lastBuildInfo.duration = Date.now() - cycleStart;
			}

			showReadyScreen(trigger);
		}

		// Debounce timer for file changes
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const DEBOUNCE_MS = 150;

		// Pending changes during debounce
		let pendingTrigger: string | null = null;
		let pendingIsTerraform: boolean = false;

		// Handle file change with debouncing
		function handleFileChange(trigger: string, isTerraform: boolean = false): void {
			pendingTrigger = trigger;
			pendingIsTerraform = isTerraform;

			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(async () => {
				debounceTimer = null;
				const triggerName = pendingTrigger || trigger;
				const terraformOnly = pendingIsTerraform;
				pendingTrigger = null;
				pendingIsTerraform = false;

				if (terraformOnly && localstackEnabled) {
					await runTerraformCycle(triggerName);
				} else {
					await runBuildCycle(triggerName);
				}
			}, DEBOUNCE_MS);
		}

		// Initial build
		await runBuildCycle();

		// Set up lambda file watcher
		const lambdaWatcher = watch(
			lambdasDir,
			{ recursive: false },
			(event, filename) => {
				if (
					!filename ||
					!filename.endsWith(".ts") ||
					filename.startsWith("__")
				) {
					return;
				}

				handleFileChange(filename, false);
			},
		);

		// Set up terraform watcher if LocalStack is enabled
		let terraformWatcher: ReturnType<typeof watch> | null = null;

		if (localstackEnabled && existsSync(terraformDir)) {
			terraformWatcher = watch(
				terraformDir,
				{ recursive: false },
				(event, filename) => {
					if (!filename) return;

					// Skip auto-generated files and tflocal override files
					if (
						filename === config.terraform.tfvarsFilename ||
						filename.endsWith(".auto.tfvars") ||
						filename.startsWith(".terraform") ||
						filename.endsWith(".tfstate") ||
						filename.endsWith(".tfstate.backup") ||
						filename.includes("override") ||
						filename.startsWith("localstack")
					) {
						return;
					}

					// Only watch .tf files
					if (!filename.endsWith(".tf")) {
						return;
					}

					handleFileChange(filename, true);
				},
			);
		}

		// Handle graceful shutdown
		process.on("SIGINT", () => {
			ui.blank();
			ui.info("Stopping...");
			lambdaWatcher.close();
			if (terraformWatcher) {
				terraformWatcher.close();
			}

			// Clear debounce timer
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			// Clean up temp directory
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
