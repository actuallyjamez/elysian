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
import {
	discoverLambdas,
	type DiscoveredApiRoute,
	type DiscoveredLambda,
	type DiscoveryResult,
} from "../../core/discovery";
import {
	logger,
	printHeader,
	printBlank,
	clearScreen,
	createSpinner as createLoggerSpinner,
	startInvocation,
	endInvocation,
	printDevStatus,
	printDevError,
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

		let config: ResolvedConfig;
		try {
			config = await loadConfig();
			logger.success("Loaded configuration");
		} catch (error) {
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

		// Detect LocalStack (optional)
		let usingLocalStack = false;
		if (!args["no-localstack"]) {
			const detection = await detectLocalStack();
			if (detection.available) {
				usingLocalStack = true;
				logger.success("LocalStack detected");
			} else {
				if (!detection.localstackRunning) {
					logger.warn("LocalStack not running");
				}
				if (!detection.tfLocalInstalled) {
					logger.warn("tflocal not installed");
				}
			}
		}

		// Verify terraform is available when not using LocalStack
		if (!usingLocalStack) {
			const terraformAvailable = await isTerraformInstalled();
			if (!terraformAvailable) {
				logger.error("terraform CLI not found. Install terraform or use LocalStack.");
				process.exit(1);
			}
			logger.info("Using AWS (ensure credentials are configured)");
		}

		// Ensure terraform init
		if (!isTerraformInitialized(terraformDir)) {
			const spinner = createLoggerSpinner("Initializing terraform...").start();
			const initResult = usingLocalStack
				? await runTfLocalInit(terraformDir)
				: await runTerraformInit(terraformDir);
			if (!initResult.success) {
				spinner.fail("Terraform init failed");
				logger.error(initResult.error || "Unknown error");
				process.exit(1);
			}
			spinner.succeed("Terraform initialized");
		}

		// Build state
		let discovered = discoverLambdas(cwd, config);
		log(`Found ${discovered.apiRoutes.length} API routes, ${discovered.functions.length} generic functions`);
		
		// Check if we have anything to build
		if (discovered.apiRoutes.length === 0 && discovered.functions.length === 0) {
			logger.warn(`No lambda files found in ${config.api.dir} or ${config.functions.dir}`);
			process.exit(1);
		}

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

		// Bundle stub and lambdas BEFORE terraform apply (terraform needs the stub zip)
		const initialBuildResult = await bundleAll();
		if (!initialBuildResult.success) {
			logger.error(`Initial build failed: ${initialBuildResult.error}`);
			process.exit(1);
		}
		log(`Initial build completed: ${initialBuildResult.apiRouteCount} API routes, ${initialBuildResult.genericLambdaCount} functions`);

		// Generate manifest and terraform vars
		const manifestResult = await generateManifestFiles();
		if (!manifestResult.success) {
			logger.error(`Manifest generation failed: ${manifestResult.error}`);
			process.exit(1);
		}

		// Now we can provision infrastructure (stub zip exists)
		let liveConfig = await ensureInfrastructure();
		log(`Live config: API=${liveConfig.apiEndpoint}, AppSync HTTP=${liveConfig.appSyncHttpEndpoint}`);

		workerRunner = createWorkerRunner({
			outputDir,
			appName: name,
			onError: (lambdaName, error) => {
				logger.warn(`${lambdaName}: ${error.message}`);
			},
			// Console output from handlers goes directly to stdout via worker
		});

		const appsyncClient = await startBridge(workerRunner, liveConfig);

		// Load workers for all lambdas
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
		showReadyScreen();

		process.on("SIGINT", async () => {
			printBlank();
			logger.info("Stopping...");
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

		async function ensureInfrastructure(spinnerLabel: string | null = "Initializing...") {
			const spinner = spinnerLabel ? createLoggerSpinner(spinnerLabel).start() : null;
			const applyResult = usingLocalStack
				? await runTfLocalApplyDevMode(terraformDir)
				: await runTerraformApplyDevMode(terraformDir);
			if (!applyResult.success) {
				spinner?.fail("Terraform apply failed");
				logger.error(applyResult.error || "Unknown terraform error");
				process.exit(1);
			}
			spinner?.succeed("Initialized");

			const config = usingLocalStack
				? await getLiveModeConfig(terraformDir, true)
				: await getLiveModeConfigAws(terraformDir);
			if (!config) {
				logger.error("Live mode outputs missing. Run `elysian init` again?");
				process.exit(1);
			}
			return config;
		}

		async function startBridge(runner: WorkerRunner, config: Awaited<ReturnType<typeof ensureInfrastructure>>) {
			const spinner = createLoggerSpinner("Connecting to AppSync...").start();
			log(`Connecting to AppSync realtime: ${config.appSyncRealtimeEndpoint}`);
			try {
				const client = await createAppSyncClient({
					httpEndpoint: config.appSyncHttpEndpoint,
					realtimeEndpoint: config.appSyncRealtimeEndpoint,
					apiKey: config.appSyncApiKey,
					lambdaNames: getAllLambdaNames(),
					onInvoke: async (request) => {
						// Start tracking the invocation with full context
						// Pass app name so we can strip it from display
						const invocationLogger = startInvocation(
							request.lambdaName,
							request.requestId,
							request.event,
							name, // app name for display name extraction
						);

						try {
							const response = await runner.invoke(request);

							// End invocation with appropriate status
							if (response.error) {
								endInvocation(request.requestId, undefined, response.error.message);
							} else {
								const statusCode = (response.response as { statusCode?: number })?.statusCode;
								endInvocation(request.requestId, statusCode);
							}

							return response;
						} catch (error) {
							endInvocation(
								request.requestId,
								undefined,
								error instanceof Error ? error : String(error),
							);
							throw error;
						}
					},
					onConnect: () => {
						log("WebSocket connected to AppSync");
						spinner.succeed("Bridge connected");
					},
					onError: (error) => logger.warn(`Bridge error: ${error.message}`),
				});
				return client;
			} catch (error) {
				spinner.fail("Bridge connection failed");
				logger.error(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
		}

		async function fullBuildCycle(trigger?: string) {
			const start = Date.now();
			lastError = null;

			clearScreen();
			printHeader("\x1b[90mdev\x1b[0m");
			if (trigger) {
				logger.info(`Change: ${trigger}`);
				printBlank();
			}

			const buildSpinner = createLoggerSpinner("Bundling lambdas...").start();
			const buildResult = await bundleAll();
			if (!buildResult.success) {
				buildSpinner.fail("Bundle failed");
				lastError = buildResult.error ?? "Bundle failed";
				showReadyScreen(trigger, true);
				return;
			}
			const totalLambdas = buildResult.apiRouteCount + buildResult.genericLambdaCount;
			buildSpinner.succeed(`Bundled ${totalLambdas} lambda${totalLambdas === 1 ? "" : "s"}`);

			const manifestSpinner = createLoggerSpinner("Updating manifest...").start();
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

			showReadyScreen(trigger);
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

			clearScreen();
			printHeader("\x1b[90mdev\x1b[0m");
			if (trigger) {
				logger.info(`Change: ${trigger}`);
				printBlank();
			}

			const buildSpinner = createLoggerSpinner("Bundling lambdas...").start();
			const buildResult = await bundleAll();
			if (!buildResult.success) {
				buildSpinner.fail("Bundle failed");
				lastError = buildResult.error ?? "Bundle failed";
				showReadyScreen(trigger, true);
				return;
			}
			const totalLambdas = buildResult.apiRouteCount + buildResult.genericLambdaCount;
			buildSpinner.succeed(`Bundled ${totalLambdas} lambda${totalLambdas === 1 ? "" : "s"}`);

			const manifestSpinner = createLoggerSpinner("Updating manifest...").start();
			const manifestResult = await generateManifestFiles();
			if (!manifestResult.success) {
				manifestSpinner.fail("Manifest failed");
				lastError = manifestResult.error ?? "Manifest failed";
				showReadyScreen(trigger, true);
				return;
			}
			manifestSpinner.succeed("Manifest updated");

			// Check if terraform is needed by comparing manifests
			const diff = compareManifests(previousManifest, manifestResult.manifest!);
			if (diff.requiresTerraform) {
				logger.info("Infrastructure changes detected:");
				for (const change of diff.changes) {
					logger.info(`  \x1b[90m→\x1b[0m ${change}`);
				}
				liveConfig = await ensureInfrastructure("Applying infrastructure changes...");
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

			showReadyScreen(trigger);
		}

		async function bundleAll(): Promise<{ success: boolean; apiRouteCount: number; genericLambdaCount: number; error?: string }> {
			// Re-discover in case files changed
			discovered = discoverLambdas(cwd, config);
			
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

		function showReadyScreen(trigger?: string, failed?: boolean) {
			clearScreen();
			printHeader("\x1b[90mdev\x1b[0m");

			if (failed) {
				printDevError({
					error: lastError || "Unknown error",
					trigger,
				});
				return;
			}

			if (!lastBuildInfo) {
				return;
			}

			// Prepare API routes data grouped by lambda
			const apiRoutes: Array<{
				lambda: string;
				routes: Array<{ method: string; path: string; pathParameters: string[] }>;
				size?: number;
			}> = [];

			if (lastBuildInfo.manifest && lastBuildInfo.manifest.routes.length > 0) {
				// Group routes by lambda
				const routesByLambda = new Map<string, typeof lastBuildInfo.manifest.routes>();
				for (const route of lastBuildInfo.manifest.routes) {
					const displayName = route.lambda.startsWith(`${name}-`)
						? route.lambda.slice(name.length + 1)
						: route.lambda;
					const existing = routesByLambda.get(displayName) || [];
					existing.push(route);
					routesByLambda.set(displayName, existing);
				}

				for (const [displayName, routes] of routesByLambda) {
					apiRoutes.push({
						lambda: displayName,
						routes: routes.map((r) => ({
							method: r.method,
							path: r.path,
							pathParameters: r.pathParameters,
						})),
						size: lastBuildInfo.packageSizes.get(displayName),
					});
				}
			}

			// Prepare functions data
			const functions: Array<{
				name: string;
				trigger?: { type: string; config?: Record<string, unknown> };
				size?: number;
			}> = [];

			if (lastBuildInfo.manifest && lastBuildInfo.manifest.genericLambdas.length > 0) {
				for (const lambda of lastBuildInfo.manifest.genericLambdas) {
					functions.push({
						name: lambda.name,
						trigger: lambda.trigger ? {
							type: lambda.trigger.type,
							config: lambda.trigger.config,
						} : undefined,
						size: lastBuildInfo.packageSizes.get(lambda.name),
					});
				}
			}

			// Compute endpoints
			const hasApiRoutes = lastBuildInfo.manifest && lastBuildInfo.manifest.routes.length > 0;
			const apiEndpoint = hasApiRoutes && liveConfig ? liveConfig.apiEndpoint : undefined;
			const openapiEndpoint = hasApiRoutes && liveConfig && shouldGenerateOpenApi(config)
				? liveConfig.apiEndpoint.replace(/\/$/, "") + "/openapi"
				: undefined;

			printDevStatus({
				duration: lastBuildInfo.duration,
				apiRoutes,
				functions,
				apiEndpoint,
				openapiEndpoint,
				localstack: usingLocalStack,
			});
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
