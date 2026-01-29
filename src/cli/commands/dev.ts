/**
 * Dev command - Live mode using AppSync Events bridge
 */

import { defineCommand } from "citty";
import { watch, readdirSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, basename } from "path";
import { loadConfig, type ResolvedConfig } from "../../core/config";
import { bundleLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { bundleStub, isStubBundled } from "../../core/stub-bundler";
import { createWrapperEntry } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";
import { generateManifest, writeManifest } from "../../core/manifest";
import { writeTerraformVars } from "../../core/terraform";
import {
	shouldGenerateOpenApi,
	writeOpenApiLambda,
} from "../../core/openapi";
import {
	detectLocalStack,
	isTerraformInitialized,
	isTerraformInstalled,
	runTfLocalInit,
	runTfLocalApplyDevMode,
	runTerraformInit,
	runTerraformApplyDevMode,
	getLiveModeConfig,
	getLiveModeConfigAws,
} from "../../core/localstack";
import { createAppSyncClient } from "../../core/appsync-client";
import {
	createWorkerRunner,
	type WorkerRunner,
} from "../../core/worker-runner";
import { ui, pc, createSpinner, formatDuration } from "../ui";

export const devCommand = defineCommand({
	meta: {
		name: "dev",
		description: "Live mode - hot reload without redeploys",
	},
	args: {
		"no-localstack": {
			type: "boolean",
			description: "Skip LocalStack detection (use AWS credentials)",
			default: false,
		},
		verbose: {
			type: "boolean",
			alias: "v",
			description: "Enable verbose logging for debugging",
			default: false,
		},
	},
	async run({ args }) {
		ui.header(pc.dim("dev"));

		const startTime = Date.now();
		const verbose = args.verbose;
		const log = (message: string) => {
			if (verbose) {
				console.log(pc.dim(`[debug] ${message}`));
			}
		};

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

		if (!existsSync(lambdasDir)) {
			ui.error(`Lambdas directory not found: ${lambdasDir}`);
			process.exit(1);
		}

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });

		// Detect LocalStack (optional)
		let usingLocalStack = false;
		if (!args["no-localstack"]) {
			const detection = await detectLocalStack();
			if (detection.available) {
				usingLocalStack = true;
				ui.success("LocalStack detected");
			} else {
				if (!detection.localstackRunning) {
					ui.warn("LocalStack not running");
				}
				if (!detection.tfLocalInstalled) {
					ui.warn("tflocal not installed");
				}
			}
		}

		// Verify terraform is available when not using LocalStack
		if (!usingLocalStack) {
			const terraformAvailable = await isTerraformInstalled();
			if (!terraformAvailable) {
				ui.error("terraform CLI not found. Install terraform or use LocalStack.");
				process.exit(1);
			}
			ui.info("Using AWS (ensure credentials are configured)");
		}

		// Ensure terraform init
		if (!isTerraformInitialized(terraformDir)) {
			const spinner = createSpinner("Initializing terraform...").start();
			const initResult = usingLocalStack
				? await runTfLocalInit(terraformDir)
				: await runTerraformInit(terraformDir);
			if (!initResult.success) {
				spinner.fail("Terraform init failed");
				ui.error(initResult.error || "Unknown error");
				process.exit(1);
			}
			spinner.succeed("Terraform initialized");
		}

		// Build state
		let lambdaFiles = listLambdaFiles();
		log(`Found ${lambdaFiles.length} lambda files: ${lambdaFiles.join(", ")}`);
		let workerRunner: WorkerRunner;
		let lastError: string | null = null;
		let lastBuildInfo: {
			lambdas: number;
			routes: number;
			duration: number;
		} | null = null;
		let lambdaWatcher: ReturnType<typeof watch> | null = null;
		let terraformWatcher: ReturnType<typeof watch> | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let pendingTrigger: string | null = null;
		let pendingBuildType: "lambda" | "terraform" = "lambda";
		const DEBOUNCE_MS = 100;

		// Bundle stub and lambdas BEFORE terraform apply (terraform needs the stub zip)
		const initialBuildResult = await bundleAll();
		if (!initialBuildResult.success) {
			ui.error(`Initial build failed: ${initialBuildResult.error}`);
			process.exit(1);
		}
		log(`Initial build completed: ${initialBuildResult.count} lambdas`);

		// Generate manifest and terraform vars
		const manifestResult = await generateManifestFiles();
		if (!manifestResult.success) {
			ui.error(`Manifest generation failed: ${manifestResult.error}`);
			process.exit(1);
		}

		// Now we can provision infrastructure (stub zip exists)
		let liveConfig = await ensureInfrastructure();
		log(`Live config: API=${liveConfig.apiEndpoint}, AppSync HTTP=${liveConfig.appSyncHttpEndpoint}`);

		workerRunner = createWorkerRunner({
			outputDir,
			appName: name,
			onError: (lambdaName, error) => {
				ui.warn(`${lambdaName}: ${error.message}`);
			},
		});

		const appsyncClient = await startBridge(workerRunner, liveConfig);

		// Load workers for all lambdas
		await workerRunner.reloadAll();

		lastBuildInfo = {
			lambdas: initialBuildResult.count,
			routes: manifestResult.routes,
			duration: Date.now() - startTime,
		};

		watchFiles();
		showReadyScreen();

		process.on("SIGINT", async () => {
			ui.blank();
			ui.info("Stopping...");
			appsyncClient?.disconnect();
			workerRunner?.terminate();
			lambdaWatcher?.close();
			terraformWatcher?.close?.();
			cleanupTemp();
			process.exit(0);
		});

		await new Promise(() => {});

		function listLambdaFiles(): string[] {
			return readdirSync(lambdasDir).filter(
				(f) => f.endsWith(".ts") && !f.startsWith("__"),
			);
		}

		/**
		 * Get all lambda bundle names including the openapi lambda if enabled
		 */
		function getAllLambdaNames(): string[] {
			const names = lambdaFiles.map((file) =>
				getLambdaBundleName(name, file.replace(/\.ts$/, "")),
			);
			if (shouldGenerateOpenApi(config)) {
				names.push(getLambdaBundleName(name, "openapi"));
			}
			return names;
		}

		async function ensureInfrastructure(spinnerLabel: string | null = "Initializing...") {
			const spinner = spinnerLabel ? createSpinner(spinnerLabel).start() : null;
			const applyResult = usingLocalStack
				? await runTfLocalApplyDevMode(terraformDir)
				: await runTerraformApplyDevMode(terraformDir);
			if (!applyResult.success) {
				spinner?.fail("Terraform apply failed");
				ui.error(applyResult.error || "Unknown terraform error");
				process.exit(1);
			}
			spinner?.succeed("Initialized");

			const config = usingLocalStack
				? await getLiveModeConfig(terraformDir, true)
				: await getLiveModeConfigAws(terraformDir);
			if (!config) {
				ui.error("Live mode outputs missing. Run `elysian init` again?");
				process.exit(1);
			}
			return config;
		}

		async function startBridge(runner: WorkerRunner, config: Awaited<ReturnType<typeof ensureInfrastructure>>) {
			const spinner = createSpinner("Connecting to AppSync...").start();
			log(`Connecting to AppSync realtime: ${config.appSyncRealtimeEndpoint}`);
			try {
				const client = await createAppSyncClient({
					httpEndpoint: config.appSyncHttpEndpoint,
					realtimeEndpoint: config.appSyncRealtimeEndpoint,
					apiKey: config.appSyncApiKey,
					lambdaNames: getAllLambdaNames(),
					onInvoke: async (request) => {
						log(`Received invoke: ${request.lambdaName} (${request.requestId})`);
						const response = await runner.invoke(request);
						log(`Completed invoke: ${request.lambdaName} (${request.requestId})`);
						return response;
					},
					onConnect: () => {
						log("WebSocket connected to AppSync");
						spinner.succeed("Bridge connected");
					},
					onError: (error) => ui.warn(`Bridge error: ${error.message}`),
				});
				return client;
			} catch (error) {
				spinner.fail("Bridge connection failed");
				ui.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		}

		async function fullBuildCycle(trigger?: string) {
			const start = Date.now();
			lastError = null;

			ui.clear();
			ui.header(pc.dim("dev"));
			if (trigger) {
				ui.info(`Change: ${trigger}`);
				ui.blank();
			}

			const buildSpinner = createSpinner("Bundling lambdas...").start();
			const buildResult = await bundleAll();
			if (!buildResult.success) {
				buildSpinner.fail("Bundle failed");
				lastError = buildResult.error ?? "Bundle failed";
				showReadyScreen(trigger, true);
				return;
			}
			buildSpinner.succeed(`Bundled ${buildResult.count} lambda${buildResult.count === 1 ? "" : "s"}`);

			const manifestSpinner = createSpinner("Updating manifest...").start();
			const manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				manifestSpinner.fail("Manifest failed");
				lastError = manifestResult.error ?? "Manifest failed";
				showReadyScreen(trigger, true);
				return;
			}
			manifestSpinner.succeed("Manifest updated");

			// Re-apply terraform to ensure new lambdas exist remotely
			liveConfig = await ensureInfrastructure(null);

			lastBuildInfo = {
				lambdas: buildResult.count,
				routes: manifestResult.routes,
				duration: Date.now() - start,
			};

			await appsyncClient.updateLambdas(getAllLambdaNames());
			await workerRunner?.reloadAll();

			showReadyScreen(trigger);
		}

		/**
		 * Lambda-only build cycle - just rebundle and reload workers
		 * No terraform apply needed since stub Lambda doesn't change
		 */
		async function lambdaOnlyBuildCycle(trigger?: string) {
			const start = Date.now();
			lastError = null;

			ui.clear();
			ui.header(pc.dim("dev"));
			if (trigger) {
				ui.info(`Change: ${trigger}`);
				ui.blank();
			}

			const buildSpinner = createSpinner("Bundling lambdas...").start();
			const buildResult = await bundleAll();
			if (!buildResult.success) {
				buildSpinner.fail("Bundle failed");
				lastError = buildResult.error ?? "Bundle failed";
				showReadyScreen(trigger, true);
				return;
			}
			buildSpinner.succeed(`Bundled ${buildResult.count} lambda${buildResult.count === 1 ? "" : "s"}`);

			const manifestSpinner = createSpinner("Updating manifest...").start();
			const manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				manifestSpinner.fail("Manifest failed");
				lastError = manifestResult.error ?? "Manifest failed";
				showReadyScreen(trigger, true);
				return;
			}
			manifestSpinner.succeed("Manifest updated");

			lastBuildInfo = {
				lambdas: buildResult.count,
				routes: manifestResult.routes,
				duration: Date.now() - start,
			};

			// Update subscriptions if lambda list changed
			await appsyncClient.updateLambdas(getAllLambdaNames());

			// Reload workers to pick up new code
			await workerRunner?.reloadAll();

			showReadyScreen(trigger);
		}

		async function bundleAll(): Promise<{ success: boolean; count: number; error?: string }> {
			lambdaFiles = listLambdaFiles();
			const filesToBuild = [...lambdaFiles];

			if (shouldGenerateOpenApi(config)) {
				await writeOpenApiLambda(lambdaFiles, lambdasDir, config, tempDir);
				filesToBuild.push("openapi.ts");
			}

			await ensureStubBundled();

			for (const file of filesToBuild) {
				const result = await bundleSingle(file);
				if (!result.success) {
					return {
						success: false,
						count: 0,
						error: `${file}: ${result.error || "Unknown error"}`,
					};
				}
			}

			return { success: true, count: filesToBuild.length };
		}

		async function bundleSingle(filename: string): Promise<{ success: boolean; error?: string }> {
			const lambdaName = filename.replace(/\.ts$/, "");
			const bundleName = getLambdaBundleName(name, lambdaName);
			const sourcePath = filename === "openapi.ts"
				? join(tempDir, filename)
				: join(lambdasDir, filename);

			const wrapperPath = join(tempDir, `${lambdaName}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(sourcePath);
			await Bun.write(wrapperPath, wrapperContent);

			const buildResult = await bundleLambda(
				bundleName,
				wrapperPath,
				outputDir,
				config,
			);

			if (!buildResult.success) {
				return { success: false, error: buildResult.error };
			}

			// Package into zip for Terraform
			const packageResult = await packageLambda(
				bundleName,
				buildResult.outputPath,
				outputDir,
			);

			if (!packageResult.success) {
				return { success: false, error: packageResult.error };
			}

			return { success: true };
		}

		async function ensureStubBundled() {
			if (isStubBundled(outputDir)) {
				return;
			}
			const spinner = createSpinner("Bundling stub lambda...").start();
			const result = await bundleStub(outputDir);
			if (!result.success) {
				spinner.fail("Stub bundle failed");
				ui.error(result.error || "Unknown stub error");
				process.exit(1);
			}
			spinner.succeed("Stub bundled");
		}

		async function generateManifestFiles(): Promise<{ success: boolean; routes: number; error?: string }> {
			try {
				const filesToManifest = [...lambdaFiles];
				if (shouldGenerateOpenApi(config)) {
					filesToManifest.push("openapi.ts");
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
			} catch (error) {
				return {
					success: false,
					routes: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		function showReadyScreen(trigger?: string, failed?: boolean) {
			ui.clear();
			ui.header(pc.dim("dev"));

			if (failed) {
				ui.error("Live mode failed");
				if (trigger) {
					ui.info(`Trigger: ${trigger}`);
				}
				if (lastError) {
					console.log(pc.red(lastError));
				}
			} else if (lastBuildInfo) {
				ui.success(
					`ready in ${pc.bold(formatDuration(lastBuildInfo.duration))}`,
				);
				console.log(
					pc.dim(
						`  ${lastBuildInfo.lambdas} lambda${lastBuildInfo.lambdas === 1 ? "" : "s"} · ${lastBuildInfo.routes} routes`,
					),
				);
			}

			ui.blank();
			if (liveConfig) {
				console.log(
					`  ${pc.dim("➜")}  ${pc.bold("api")}      ${pc.cyan(liveConfig.apiEndpoint)}`,
				);
				console.log(
					`  ${pc.dim("➜")}  ${pc.bold("appsync")}  ${pc.cyan(liveConfig.appSyncHttpEndpoint)}`,
				);
			}
		}

		function watchFiles() {
			lambdaWatcher = watch(lambdasDir, { recursive: false }, (event, filename) => {
				if (!filename || !filename.endsWith(".ts")) {
					return;
				}
				scheduleBuild(filename, "lambda");
			});

			if (existsSync(terraformDir)) {
				terraformWatcher = watch(
					terraformDir,
					{ recursive: false },
					(event, filename) => {
						if (!filename || !filename.endsWith(".tf")) {
							return;
						}
						// Ignore temp files created during terraform apply
						if (filename === "localstack_providers_override.tf") {
							return;
						}
						scheduleBuild(filename, "terraform");
					},
				);
			}
		}

		function scheduleBuild(trigger: string, buildType: "lambda" | "terraform") {
			pendingTrigger = trigger;
			// Terraform changes take precedence (require full rebuild)
			if (buildType === "terraform" || pendingBuildType !== "terraform") {
				pendingBuildType = buildType;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				const triggerName = pendingTrigger ? basename(pendingTrigger) : undefined;
				const type = pendingBuildType;
				pendingTrigger = null;
				pendingBuildType = "lambda";

				if (type === "terraform") {
					fullBuildCycle(triggerName);
				} else {
					lambdaOnlyBuildCycle(triggerName);
				}
			}, DEBOUNCE_MS);
		}

		function cleanupTemp() {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	},
});
