/**
 * File scaffolding logic
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import type { PackageManager, ProjectInfo } from "./detect";
import type { WizardAnswers } from "./prompts";
import {
	configTemplate,
	exampleApiRouteTemplate,
	exampleGenericLambdaTemplate,
	packageJsonTemplate,
	gitignoreTemplate,
	tsconfigTemplate,
	ensurePackageJsonFields,
} from "./templates";
import {
	moduleTemplates,
	rootTemplates,
} from "./terraform-module";
import { logger, printBlank } from "../../logger";

export interface ScaffoldResult {
	created: string[];
	updated: string[];
	skipped: string[];
}

/**
 * Read file content or return empty string if not exists
 */
async function readFileOrEmpty(path: string): Promise<string> {
	if (!existsSync(path)) {
		return "";
	}
	return await Bun.file(path).text();
}

/**
 * Write file and track in result
 */
async function writeFile(
	path: string,
	content: string,
	result: ScaffoldResult,
	isUpdate: boolean,
): Promise<void> {
	await Bun.write(path, content);
	if (isUpdate) {
		result.updated.push(path);
	} else {
		result.created.push(path);
	}
}

/**
 * Scaffold all project files
 */
export async function scaffoldProject(
	cwd: string,
	info: ProjectInfo,
	answers: WizardAnswers,
	force: boolean,
): Promise<ScaffoldResult> {
	const result: ScaffoldResult = {
		created: [],
		updated: [],
		skipped: [],
	};

	// Create directories
	const apiDir = join(cwd, "src/api");
	const functionsDir = join(cwd, "src/functions");
	const terraformDir = join(cwd, "terraform");

	if (!existsSync(apiDir)) {
		mkdirSync(apiDir, { recursive: true });
	}
	if (!existsSync(functionsDir)) {
		mkdirSync(functionsDir, { recursive: true });
	}
	if (!existsSync(terraformDir)) {
		mkdirSync(terraformDir, { recursive: true });
	}

	// For fresh projects, create package.json, .gitignore, tsconfig.json
	if (info.isEmpty) {
		const packageJsonPath = join(cwd, "package.json");
		await writeFile(
			packageJsonPath,
			packageJsonTemplate(answers.name),
			result,
			false,
		);

		const gitignorePath = join(cwd, ".gitignore");
		if (!existsSync(gitignorePath)) {
			await writeFile(gitignorePath, gitignoreTemplate(), result, false);
		}

		const tsconfigPath = join(cwd, "tsconfig.json");
		if (!existsSync(tsconfigPath)) {
			await writeFile(tsconfigPath, tsconfigTemplate(), result, false);
		}
	} else {
		// For existing projects, ensure package.json has required fields
		const packageJsonPath = join(cwd, "package.json");
		if (existsSync(packageJsonPath)) {
			const existing = await readFileOrEmpty(packageJsonPath);
			const updated = ensurePackageJsonFields(existing, answers.name);
			if (updated) {
				await writeFile(packageJsonPath, updated, result, true);
			}
		} else {
			// No package.json exists, create one
			await writeFile(
				packageJsonPath,
				packageJsonTemplate(answers.name),
				result,
				false,
			);
		}
	}

	// Create elysian.config.ts
	const configPath = join(cwd, "elysian.config.ts");
	if (!existsSync(configPath) || force) {
		await writeFile(
			configPath,
			configTemplate(answers.name),
			result,
			existsSync(configPath),
		);
	} else {
		result.skipped.push(configPath);
	}

	// Create example files (only if no lambda files exist)
	if (!info.hasLambdaFiles) {
		// Create example API route in src/api/
		const exampleApiPath = join(apiDir, "hello.ts");
		await writeFile(exampleApiPath, exampleApiRouteTemplate(), result, false);

		// Create example generic function in src/functions/
		const exampleFunctionPath = join(functionsDir, "process-queue.ts");
		await writeFile(exampleFunctionPath, exampleGenericLambdaTemplate(), result, false);
	}

	// Handle Terraform files
	await scaffoldTerraform(cwd, info, answers.name, result);

	return result;
}

/**
 * Scaffold Terraform files with module structure
 */
async function scaffoldTerraform(
	cwd: string,
	_info: ProjectInfo,
	name: string,
	result: ScaffoldResult,
): Promise<void> {
	const tfDir = join(cwd, "terraform");
	const moduleDir = join(tfDir, "modules", "elysian");

	// Create module directory
	if (!existsSync(moduleDir)) {
		mkdirSync(moduleDir, { recursive: true });
	}

	// Write module files (always overwrite - Elysian-managed)
	const moduleFiles = [
		{ name: "variables.tf", content: moduleTemplates.variables },
		{ name: "main.tf", content: moduleTemplates.main },
		{ name: "iam.tf", content: moduleTemplates.iam },
		{ name: "live.tf", content: moduleTemplates.live },
		{ name: "triggers.tf", content: moduleTemplates.triggers },
		{ name: "outputs.tf", content: moduleTemplates.outputs },
	];

	for (const file of moduleFiles) {
		const filePath = join(moduleDir, file.name);
		const existed = existsSync(filePath);
		await writeFile(filePath, file.content, result, existed);
	}

	// Write root files (only if they don't exist - user-owned after creation)
	const rootFiles = [
		{ name: "providers.tf", content: rootTemplates.providers },
		{ name: "variables.tf", content: rootTemplates.variables(name) },
		{ name: "main.tf", content: rootTemplates.main(name) },
		{ name: "outputs.tf", content: rootTemplates.outputs },
	];

	for (const file of rootFiles) {
		const filePath = join(tfDir, file.name);
		if (!existsSync(filePath)) {
			await writeFile(filePath, file.content, result, false);
		} else {
			result.skipped.push(filePath);
		}
	}
}

/**
 * Install dependencies using the specified package manager
 */
export async function installDependencies(
	cwd: string,
	packageManager: PackageManager,
): Promise<void> {
	const deps = ["elysia", "@actuallyjamez/elysian"];
	const devDeps = ["@types/node", "typescript"];

	const addCmd = packageManager === "npm" ? "install" : "add";
	const devFlag = packageManager === "npm" ? "--save-dev" : "-D";

	logger.info("Installing dependencies...");

	// Install main dependencies
	const addProc = spawn([packageManager, addCmd, ...deps], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	await addProc.exited;

	if (addProc.exitCode !== 0) {
		const stderr = await new Response(addProc.stderr).text();
		throw new Error(`Failed to install dependencies: ${stderr}`);
	}

	// Install dev dependencies
	const devProc = spawn([packageManager, addCmd, devFlag, ...devDeps], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	await devProc.exited;

	if (devProc.exitCode !== 0) {
		const stderr = await new Response(devProc.stderr).text();
		throw new Error(`Failed to install dev dependencies: ${stderr}`);
	}

	logger.success("Dependencies installed");
}

/**
 * Get relative path for display
 */
export function getRelativePath(cwd: string, fullPath: string): string {
	return fullPath.replace(cwd + "/", "");
}

/**
 * Print scaffold results
 */
export function printResults(cwd: string, result: ScaffoldResult): void {
	printBlank();

	for (const path of result.created) {
		logger.success(`Created ${getRelativePath(cwd, path)}`);
	}

	for (const path of result.updated) {
		logger.success(`Updated ${getRelativePath(cwd, path)}`);
	}

	// Don't print skipped files - too noisy
}
