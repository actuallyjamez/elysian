/**
 * Dev command - Live mode using AppSync Events bridge
 *
 * Supports both API routes (src/api/) and generic functions (src/functions/).
 */

import { defineCommand } from "citty";
import { watch, mkdirSync, existsSync, rmSync, readdirSync } from "fs";
import { join, basename } from "path";
import { loadConfig, type ResolvedConfig } from "../../core/config";
import { bundleApiRoute, bundleGenericLambda } from "../../core/bundler";
import { packageLambda } from "../../core/packager";
import { bundleStub, isStubBundled } from "../../core/stub-bundler";
import { createWrapperEntry, createGenericLambdaWrapper } from "../../core/handler-wrapper";
import { getLambdaBundleName } from "../../core/naming";
import { generateManifest, writeManifest, compareManifests, type ApiManifest } from "../../core/manifest";
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
	runTerraformInit,
	getLiveModeConfig,
	getLiveModeConfigAws,
	runTfLocalApplyDevModeWithRetry,
	runTerraformApplyDevModeWithRetry,
	verifyTerraformOutputs,
	type TerraformProgress,
} from "../../core/localstack";
import { createAppSyncClient } from "../../core/appsync-client";
import {
	createWorkerRunner,
	type WorkerRunner,
} from "../../core/worker-runner";
import {
	discoverLambdas,
	type DiscoveredApiRoute,
	type DiscoveredLambda,
	type DiscoveryResult,
} from "../../core/discovery";
import {
	logger,
	printHeader,
	createSpinner as createLoggerSpinner,
	createStatusLine,
	concurrentLogger,
	formatDuration,
	formatLink,
	type StatusLine,
} from "../logger";

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
		printHeader("\x1b[90mdev\x1b[0m");

		const startTime = Date.now();
		const verbose = args.verbose;
		const log = (message: string) => {
			if (verbose) {
				logger.debug(message);
			}
		};

		// Create status line for setup progress (single updating line)
		const setup = createStatusLine();

		let config: ResolvedConfig;
		try {
			setup.update("Loading configuration...");
			config = await loadConfig();
			log("Loaded configuration");
		} catch (error) {
			setup.error("Failed to load configuration");
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}

		const cwd = process.cwd();
		const name = config.name;
		const apiDir = join(cwd, config.api.dir);
		const functionsDir = join(cwd, config.functions.dir);
		const outputDir = join(cwd, config.outputDir);
		const terraformDir = join(cwd, config.terraform.outputDir);
		const tempDir = join(outputDir, "__temp__");

		mkdirSync(outputDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });

		// Detect LocalStack (optional) - fast check, no status message needed
		let usingLocalStack = false;
		if (!args["no-localstack"]) {
			const detection = await detectLocalStack();
			if (detection.available) {
				usingLocalStack = true;
				log("LocalStack detected");
			} else {
				if (!detection.localstackRunning) {
					log("LocalStack not running");
				}
				if (!detection.tfLocalInstalled) {
					log("tflocal not installed");
				}
			}
		}

		// Verify terraform is available when not using LocalStack
		if (!usingLocalStack) {
			const terraformAvailable = await isTerraformInstalled();
			if (!terraformAvailable) {
				setup.error("terraform CLI not found");
				logger.error("Install terraform or use LocalStack.");
				process.exit(1);
			}
			log("Using AWS");
		}

		// Ensure terraform init
		if (!isTerraformInitialized(terraformDir)) {
			setup.update("Initializing terraform...");
			const initResult = usingLocalStack
				? await runTfLocalInit(terraformDir)
				: await runTerraformInit(terraformDir);
			if (!initResult.success) {
				setup.error("Terraform init failed");
				logger.error(initResult.error || "Unknown error");
				process.exit(1);
			}
		}

		// Build state - initial discovery without warnings (bundleAll will warn on re-discovery)
		setup.update("Discovering lambdas...");
		let discovered = await discoverLambdas(cwd, config);
		log(`Found ${discovered.apiRoutes.length} API routes, ${discovered.functions.length} generic functions`);
		
		// Track whether we have any lambdas (allow empty start for watching)
		const hasLambdas = discovered.apiRoutes.length > 0 || discovered.functions.length > 0;

		let workerRunner: WorkerRunner;
		let lastError: string | null = null;
		let lastBuildInfo: {
			apiRouteCount: number;
			genericLambdaCount: number;
			routes: number;
			duration: number;
			manifest: ApiManifest | null;
			packageSizes: Map<string, number>;
		} | null = null;
		let apiWatcher: ReturnType<typeof watch> | null = null;
		let lambdaWatcher: ReturnType<typeof watch> | null = null;
		let terraformWatcher: ReturnType<typeof watch> | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let pendingTrigger: string | null = null;
		let pendingBuildType: "lambda" | "terraform" = "lambda";
		let buildInProgress = false;
		let queuedBuild: { trigger: string; type: "lambda" | "terraform" } | null = null;
		const DEBOUNCE_MS = 100;

		// Track whether we've shown the endpoints (only show once)
		let hasShownApiEndpoint = false;
		let hasShownOpenapiEndpoint = false;

		// Bundle stub and lambdas BEFORE terraform apply (terraform needs the stub zip)
		// Skip initial bundle if no lambdas (but still apply terraform for user's other infrastructure)
		let initialBuildResult: { success: boolean; apiRouteCount: number; genericLambdaCount: number; error?: string } = { 
			success: true, 
			apiRouteCount: 0, 
			genericLambdaCount: 0 
		};
		if (hasLambdas) {
			setup.update("Bundling lambdas...");
			initialBuildResult = await bundleAll();
			if (!initialBuildResult.success) {
				setup.error("Build failed");
				logger.error(initialBuildResult.error || "Unknown error");
				process.exit(1);
			}
			log(`Initial build completed: ${initialBuildResult.apiRouteCount} API routes, ${initialBuildResult.genericLambdaCount} functions`);
		}

		// Generate manifest and terraform vars (skip if no lambdas)
		let manifestResult: { success: boolean; routes: number; manifest: ApiManifest | null; error?: string } = {
			success: true,
			routes: 0,
			manifest: null,
		};
		if (hasLambdas) {
			setup.update("Generating manifest...");
			manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				setup.error("Manifest generation failed");
				logger.error(manifestResult.error || "Unknown error");
				process.exit(1);
			}
		}

		// Now we can provision infrastructure (stub zip exists)
		let liveConfig = await ensureInfrastructure(setup);
		log(`Live config: API=${liveConfig.apiEndpoint}, AppSync HTTP=${liveConfig.appSyncHttpEndpoint}`);

		workerRunner = createWorkerRunner({
			outputDir,
			appName: name,
			onError: (lambdaName, error) => {
				logger.warn(`${lambdaName}: ${error.message}`);
			},
			onConsole: (lambdaName, requestId, level, message) => {
				// Route console output through the concurrent logger for grouping
				concurrentLogger.log(requestId, level, message);
			},
		});

		setup.update("Connecting...");
		const appsyncClient = await startBridge(workerRunner, liveConfig);

		// Load workers for all lambdas (fast, no status needed)
		await workerRunner.reloadAll();

		// Get package sizes for display
		const initialPackageSizes = await getPackageSizes();

		lastBuildInfo = {
			apiRouteCount: initialBuildResult.apiRouteCount,
			genericLambdaCount: initialBuildResult.genericLambdaCount,
			routes: manifestResult.routes,
			duration: Date.now() - startTime,
			manifest: manifestResult.manifest,
			packageSizes: initialPackageSizes,
		};

		watchFiles();
		showReadyScreen(setup);

		process.on("SIGINT", async () => {
			concurrentLogger.flush(); // Ensure any buffered logs are printed
			appsyncClient?.disconnect();
			workerRunner?.terminate();
			apiWatcher?.close();
			lambdaWatcher?.close();
			terraformWatcher?.close?.();
			cleanupTemp();
			process.exit(0);
		});

		await new Promise(() => {});

		/**
		 * Clean up stale output files from deleted source files
		 * This ensures deleted lambdas don't persist in the output directory
		 */
		function cleanStaleOutputFiles(currentDiscovery: DiscoveryResult) {
			// Build set of valid bundle names from current discovery
			const validBundleNames = new Set<string>();
			
			for (const route of currentDiscovery.apiRoutes) {
				validBundleNames.add(route.bundleName);
			}
			
			// OpenAPI aggregator is valid if enabled and there are API routes
			if (shouldGenerateOpenApi(config) && currentDiscovery.apiRoutes.length > 0) {
				validBundleNames.add(getLambdaBundleName(name, "openapi"));
			}
			
			for (const fn of currentDiscovery.functions) {
				validBundleNames.add(fn.bundleName);
			}
			
			// Find and remove stale .js and .zip files
			if (existsSync(outputDir)) {
				const files = readdirSync(outputDir);
				for (const file of files) {
					// Skip directories and special files
					if (file.startsWith("__") || file === "manifest.json") {
						continue;
					}
					
					// Extract bundle name from filename
					let bundleName: string | null = null;
					if (file.endsWith(".js")) {
						bundleName = file.slice(0, -3);
					} else if (file.endsWith(".zip")) {
						bundleName = file.slice(0, -4);
					}
					
					// Remove if not a valid bundle
					if (bundleName && !validBundleNames.has(bundleName)) {
						const filePath = join(outputDir, file);
						try {
							rmSync(filePath);
							log(`Removed stale output: ${file}`);
						} catch {
							// Ignore errors removing files
						}
					}
				}
			}
		}

		/**
		 * Get all lambda bundle names (API routes + functions + openapi if enabled)
		 */
		function getAllLambdaNames(): string[] {
			const names: string[] = [];
			
			// API routes
			for (const route of discovered.apiRoutes) {
				names.push(route.bundleName);
			}
			
			// OpenAPI aggregator
			if (shouldGenerateOpenApi(config)) {
				names.push(getLambdaBundleName(name, "openapi"));
			}
			
			// Generic functions
			for (const fn of discovered.functions) {
				names.push(fn.bundleName);
			}
			
			return names;
		}

		/**
		 * Get the schedule interval for a lambda from the manifest
		 * Returns the 'every' value (e.g., "1m", "1h") if it's a scheduled function
		 */
		function getScheduleInterval(lambdaName: string): string | undefined {
			if (!lastBuildInfo?.manifest) return undefined;

			const genericLambda = lastBuildInfo.manifest.genericLambdas.find(
				(l) => l.bundleName === lambdaName
			);

			if (genericLambda?.trigger?.type === "schedule" && genericLambda.trigger.config) {
				const config = genericLambda.trigger.config as { every?: string };
				return config.every;
			}

			return undefined;
		}

		async function ensureInfrastructure(setupStatus?: StatusLine) {
			setupStatus?.update("Applying terraform...");
			
			const onProgress = (progress: TerraformProgress) => {
				if (setupStatus) {
					if (progress.type === "creating" && progress.resource) {
						setupStatus.update(`Creating ${progress.resource}...`);
					} else if (progress.type === "updating" && progress.resource) {
						setupStatus.update(`Updating ${progress.resource}...`);
					} else if (progress.type === "destroying" && progress.resource) {
						setupStatus.update(`Destroying ${progress.resource}...`);
					}
					// Note: "complete" type is intentionally not handled - the next step will update the status
				}
			};
			
			const onRetry = (attempt: number, maxRetries: number, error: string) => {
				logger.warn(`Terraform apply failed, retrying (${attempt}/${maxRetries})...`);
				log(`Error was: ${error}`);
			};
			
			const applyResult = usingLocalStack
				? await runTfLocalApplyDevModeWithRetry(terraformDir, { onProgress, onRetry })
				: await runTerraformApplyDevModeWithRetry(terraformDir, { onProgress, onRetry });
			
			if (!applyResult.success) {
				setupStatus?.error("Terraform apply failed");
				logger.error(applyResult.error || "Unknown terraform error");
				process.exit(1);
			}
			
			// Verify outputs exist
			const verification = await verifyTerraformOutputs(terraformDir, usingLocalStack);
			if (!verification.valid) {
				setupStatus?.error("Terraform outputs missing");
				logger.error(`Missing outputs: ${verification.missing.join(", ")}`);
				logger.note("Run `elysian init` to regenerate terraform files");
				process.exit(1);
			}

			const tfConfig = usingLocalStack
				? await getLiveModeConfig(terraformDir, true)
				: await getLiveModeConfigAws(terraformDir);
			if (!tfConfig) {
				logger.error("Live mode outputs missing. Run `elysian init` again?");
				process.exit(1);
			}
			return tfConfig;
		}

		async function startBridge(runner: WorkerRunner, bridgeConfig: Awaited<ReturnType<typeof ensureInfrastructure>>) {
			log(`Connecting to AppSync realtime: ${bridgeConfig.appSyncRealtimeEndpoint}`);
			try {
				const client = await createAppSyncClient({
					httpEndpoint: bridgeConfig.appSyncHttpEndpoint,
					realtimeEndpoint: bridgeConfig.appSyncRealtimeEndpoint,
					apiKey: bridgeConfig.appSyncApiKey,
					lambdaNames: getAllLambdaNames(),
					onInvoke: async (request) => {
						// Look up schedule interval from manifest if this is a scheduled function
						const scheduleInterval = getScheduleInterval(request.lambdaName);

						// Start tracking the invocation with full context
						concurrentLogger.start(
							request.lambdaName,
							request.requestId,
							request.event,
							name, // app name for display name extraction
							scheduleInterval,
						);

						try {
							const response = await runner.invoke(request);

							// End invocation with appropriate status
							if (response.error) {
								concurrentLogger.end(request.requestId, undefined, response.error.message);
							} else {
								const statusCode = (response.response as { statusCode?: number })?.statusCode;
								concurrentLogger.end(request.requestId, statusCode);
							}

							return response;
						} catch (error) {
							concurrentLogger.end(
								request.requestId,
								undefined,
								error instanceof Error ? error : String(error),
							);
							throw error;
						}
					},
					onConnect: () => {
						log("WebSocket connected to AppSync");
					},
					onError: (error) => logger.warn(`Bridge error: ${error.message}`),
				});
				return client;
			} catch (error) {
				logger.error("Bridge connection failed");
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		}

		async function fullBuildCycle(trigger?: string) {
			const start = Date.now();
			lastError = null;

			// Use a single status line for the entire rebuild
			const status = createStatusLine();
			status.update(trigger ? `Rebuilding ${trigger}...` : "Rebuilding...");

			const buildResult = await bundleAll();
			if (!buildResult.success) {
				status.error(`Build failed: ${buildResult.error}`);
				lastError = buildResult.error ?? "Bundle failed";
				return;
			}

			const manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				status.error(`Manifest failed: ${manifestResult.error}`);
				lastError = manifestResult.error ?? "Manifest failed";
				return;
			}

			// Re-apply terraform (this is a full cycle, always apply)
			liveConfig = await ensureInfrastructure(status);

			const sizes = await getPackageSizes();
			lastBuildInfo = {
				apiRouteCount: buildResult.apiRouteCount,
				genericLambdaCount: buildResult.genericLambdaCount,
				routes: manifestResult.routes,
				duration: Date.now() - start,
				manifest: manifestResult.manifest,
				packageSizes: sizes,
			};

			await appsyncClient.updateLambdas(getAllLambdaNames());
			await workerRunner?.reloadAll();

			status.success(`Rebuilt in ${formatDuration(lastBuildInfo.duration)}`);

			// Show API endpoint if this is the first time we have routes
			maybeShowEndpoints();
		}

		/**
		 * Lambda-only build cycle - just rebundle and reload workers
		 * No terraform apply needed unless infrastructure config changed
		 */
		async function lambdaOnlyBuildCycle(trigger?: string) {
			const start = Date.now();
			lastError = null;

			// Store previous manifest for comparison
			const previousManifest = lastBuildInfo?.manifest ?? null;

			// Use a single status line for the entire rebuild
			const status = createStatusLine();
			status.update(trigger ? `Rebuilding ${trigger}...` : "Rebuilding...");

			const buildResult = await bundleAll();
			if (!buildResult.success) {
				status.error(`Build failed: ${buildResult.error}`);
				lastError = buildResult.error ?? "Bundle failed";
				return;
			}

			const manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				status.error(`Manifest failed: ${manifestResult.error}`);
				lastError = manifestResult.error ?? "Manifest failed";
				return;
			}

			// Check if terraform is needed by comparing manifests
			const diff = compareManifests(previousManifest, manifestResult.manifest!);
			if (diff.requiresTerraform) {
				liveConfig = await ensureInfrastructure(status);
			}

			const sizes = await getPackageSizes();
			lastBuildInfo = {
				apiRouteCount: buildResult.apiRouteCount,
				genericLambdaCount: buildResult.genericLambdaCount,
				routes: manifestResult.routes,
				duration: Date.now() - start,
				manifest: manifestResult.manifest,
				packageSizes: sizes,
			};

			// Update subscriptions if lambda list changed
			await appsyncClient.updateLambdas(getAllLambdaNames());

			// Reload workers to pick up new code
			await workerRunner?.reloadAll();

			// Show single success line
			status.success(`Rebuilt in ${formatDuration(lastBuildInfo.duration)}`);

			// Show API endpoint if this is the first time we have routes
			maybeShowEndpoints();
		}

		async function bundleAll(): Promise<{ success: boolean; apiRouteCount: number; genericLambdaCount: number; error?: string }> {
			// Re-discover in case files changed (async now with export validation)
			// Files without default exports are silently skipped
			discovered = await discoverLambdas(cwd, config);
			
			await ensureStubBundled();

			// Clean up stale output files from deleted source files
			cleanStaleOutputFiles(discovered);

			let apiRouteCount = 0;
			let genericLambdaCount = 0;

			// Bundle API routes
			let apiRoutesToBuild = [...discovered.apiRoutes];
			
			// Generate OpenAPI aggregator if enabled
			if (shouldGenerateOpenApi(config) && discovered.apiRoutes.length > 0) {
				const openApiPath = await writeOpenApiLambda(discovered.apiRoutes, config, tempDir);
				const openApiRoute: DiscoveredApiRoute = {
					name: "openapi",
					sourcePath: openApiPath,
					bundleName: getLambdaBundleName(name, "openapi"),
				};
				apiRoutesToBuild.push(openApiRoute);
			}

			for (const route of apiRoutesToBuild) {
				const result = await bundleApiRouteSingle(route);
				if (!result.success) {
					return {
						success: false,
						apiRouteCount: 0,
						genericLambdaCount: 0,
						error: `${route.name}: ${result.error || "Unknown error"}`,
					};
				}
				apiRouteCount++;
			}

			// Bundle generic functions
			for (const fn of discovered.functions) {
				const result = await bundleGenericLambdaSingle(fn);
				if (!result.success) {
					return {
						success: false,
						apiRouteCount,
						genericLambdaCount: 0,
						error: `${fn.name}: ${result.error || "Unknown error"}`,
					};
				}
				genericLambdaCount++;
			}

			return { success: true, apiRouteCount, genericLambdaCount };
		}

		async function bundleApiRouteSingle(route: DiscoveredApiRoute): Promise<{ success: boolean; error?: string }> {
			// Create wrapper entry
			const wrapperPath = join(tempDir, `${route.name}-wrapper.ts`);
			const wrapperContent = createWrapperEntry(route.sourcePath);
			await Bun.write(wrapperPath, wrapperContent);

			const buildResult = await bundleApiRoute(
				{ ...route, sourcePath: wrapperPath },
				outputDir,
				config,
			);

			if (!buildResult.success) {
				return { success: false, error: buildResult.error };
			}

			// Package into zip for Terraform
			const packageResult = await packageLambda(
				route.bundleName,
				buildResult.outputPath,
				outputDir,
			);

			if (!packageResult.success) {
				return { success: false, error: packageResult.error };
			}

			return { success: true };
		}

		async function bundleGenericLambdaSingle(lambda: DiscoveredLambda): Promise<{ success: boolean; error?: string }> {
			// Create wrapper that extracts handler from defineLambda export
			const wrapperPath = join(tempDir, `${lambda.name}-lambda-wrapper.ts`);
			const wrapperContent = createGenericLambdaWrapper(lambda.sourcePath);
			await Bun.write(wrapperPath, wrapperContent);

			const buildResult = await bundleGenericLambda(
				{ ...lambda, sourcePath: wrapperPath },
				outputDir,
				config,
			);

			if (!buildResult.success) {
				return { success: false, error: buildResult.error };
			}

			// Package into zip for Terraform
			const packageResult = await packageLambda(
				lambda.bundleName,
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
			const spinner = createLoggerSpinner("Bundling stub lambda...").start();
			const result = await bundleStub(outputDir);
			if (!result.success) {
				spinner.fail("Stub bundle failed");
				logger.error(result.error || "Unknown stub error");
				process.exit(1);
			}
			spinner.succeed("Stub bundled");
		}

		async function getPackageSizes(): Promise<Map<string, number>> {
			const sizes = new Map<string, number>();
			
			// API routes
			for (const route of discovered.apiRoutes) {
				const zipPath = join(outputDir, `${route.bundleName}.zip`);
				try {
					const stat = await Bun.file(zipPath).stat();
					if (stat) {
						sizes.set(route.name, stat.size);
					}
				} catch {
					// Ignore missing files
				}
			}

			// OpenAPI
			if (shouldGenerateOpenApi(config)) {
				const openapiBundle = getLambdaBundleName(name, "openapi");
				const zipPath = join(outputDir, `${openapiBundle}.zip`);
				try {
					const stat = await Bun.file(zipPath).stat();
					if (stat) {
						sizes.set("openapi", stat.size);
					}
				} catch {
					// Ignore
				}
			}

			// Generic functions
			for (const fn of discovered.functions) {
				const zipPath = join(outputDir, `${fn.bundleName}.zip`);
				try {
					const stat = await Bun.file(zipPath).stat();
					if (stat) {
						sizes.set(fn.name, stat.size);
					}
				} catch {
					// Ignore missing files
				}
			}

			return sizes;
		}

		async function generateManifestFiles(): Promise<{ success: boolean; routes: number; manifest: ApiManifest | null; error?: string }> {
			try {
				const manifest = await generateManifest(
					discovered.apiRoutes,
					discovered.functions,
					outputDir,
					config.api.openapi.enabled,
					name,
				);

				const manifestPath = join(outputDir, "manifest.json");
				await writeManifest(manifest, manifestPath);
				await writeTerraformVars(manifest, config);

				return { success: true, routes: manifest.routes.length, manifest };
			} catch (error) {
				return {
					success: false,
					routes: 0,
					manifest: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		/**
		 * Show API/OpenAPI endpoints if they exist and haven't been shown yet
		 */
		function maybeShowEndpoints() {
			if (!lastBuildInfo?.manifest) return;

			const hasApiRoutes = lastBuildInfo.manifest.routes.length > 0;
			const apiEndpoint = hasApiRoutes && liveConfig ? liveConfig.apiEndpoint : undefined;
			const openapiEndpoint = hasApiRoutes && liveConfig && shouldGenerateOpenApi(config)
				? liveConfig.apiEndpoint.replace(/\/$/, "") + "/openapi"
				: undefined;

			if (apiEndpoint && !hasShownApiEndpoint) {
				logger.note(`API: ${formatLink(apiEndpoint)}`);
				hasShownApiEndpoint = true;
			}
			if (openapiEndpoint && !hasShownOpenapiEndpoint) {
				logger.note(`OpenAPI: ${formatLink(openapiEndpoint)}`);
				hasShownOpenapiEndpoint = true;
			}
		}

		function showReadyScreen(setupStatus: StatusLine) {
			if (!lastBuildInfo) {
				return;
			}

			// Count routes and functions for summary
			const apiRouteCount = lastBuildInfo.manifest?.routes.length ?? 0;
			const functionCount = lastBuildInfo.manifest?.genericLambdas.length ?? 0;
			const lambdaCount = new Set(lastBuildInfo.manifest?.routes.map(r => r.lambda) || []).size;

			// Build summary string
			const parts: string[] = [];
			if (lambdaCount > 0) parts.push(`${lambdaCount} route${lambdaCount === 1 ? "" : "s"}`);
			if (functionCount > 0) parts.push(`${functionCount} function${functionCount === 1 ? "" : "s"}`);
			const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";

			// Complete the status line with success
			const readyMsg = `Ready in ${formatDuration(lastBuildInfo.duration)}${summary}`;
			setupStatus.success(readyMsg);

			// Show endpoints
			maybeShowEndpoints();

			// Show watching status
			const target = usingLocalStack ? "LocalStack" : "AWS";
			logger.watching(`for changes (${target})`);

			// Blank line to separate from invocation logs
			console.log();
		}

		function watchFiles() {
			// Watch API routes directory
			// Create directory if it doesn't exist so watcher can detect new files
			if (!existsSync(apiDir)) {
				mkdirSync(apiDir, { recursive: true });
			}
			apiWatcher = watch(apiDir, { recursive: false }, (event, filename) => {
				try {
					if (!filename || !filename.endsWith(".ts")) {
						return;
					}
					scheduleBuild(filename, "lambda");
				} catch (error) {
					logger.warn(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			apiWatcher.on("error", (error) => {
				logger.warn(`API watcher error: ${error.message}`);
			});

			// Watch generic functions directory
			// Create directory if it doesn't exist so watcher can detect new files
			if (!existsSync(functionsDir)) {
				mkdirSync(functionsDir, { recursive: true });
			}
			lambdaWatcher = watch(functionsDir, { recursive: false }, (event, filename) => {
				try {
					if (!filename || !filename.endsWith(".ts")) {
						return;
					}
					scheduleBuild(filename, "lambda");
				} catch (error) {
					logger.warn(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
			lambdaWatcher.on("error", (error) => {
				logger.warn(`Functions watcher error: ${error.message}`);
			});

			// Watch terraform directory
			if (existsSync(terraformDir)) {
				terraformWatcher = watch(
					terraformDir,
					{ recursive: false },
					(event, filename) => {
						try {
							if (!filename || !filename.endsWith(".tf")) {
								return;
							}
							if (filename === "localstack_providers_override.tf") {
								return;
							}
							scheduleBuild(filename, "terraform");
						} catch (error) {
							logger.warn(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
						}
					},
				);
				terraformWatcher.on("error", (error) => {
					logger.warn(`Terraform watcher error: ${error.message}`);
				});
			}
		}

		function scheduleBuild(trigger: string, buildType: "lambda" | "terraform") {
			if (buildInProgress) {
				if (!queuedBuild || buildType === "terraform") {
					queuedBuild = { trigger, type: buildType };
				} else if (queuedBuild.type !== "terraform") {
					queuedBuild = { trigger, type: buildType };
				}
				return;
			}

			pendingTrigger = trigger;
			if (buildType === "terraform" || pendingBuildType !== "terraform") {
				pendingBuildType = buildType;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(async () => {
				debounceTimer = null;
				const triggerName = pendingTrigger ? basename(pendingTrigger) : undefined;
				const type = pendingBuildType;
				pendingTrigger = null;
				pendingBuildType = "lambda";

				buildInProgress = true;
				try {
					if (type === "terraform") {
						await fullBuildCycle(triggerName);
					} else {
						await lambdaOnlyBuildCycle(triggerName);
					}
				} finally {
					buildInProgress = false;

					if (queuedBuild) {
						const queued = queuedBuild;
						queuedBuild = null;
						scheduleBuild(queued.trigger, queued.type);
					}
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
