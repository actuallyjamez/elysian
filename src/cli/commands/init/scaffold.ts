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
	exampleLambdaTemplate,
	packageJsonTemplate,
	gitignoreTemplate,
	tsconfigTemplate,
} from "./templates";
import {
	templates as tfTemplates,
	appendProviders,
	getMissingVariables,
	appendMain,
	appendOutputs,
} from "./terraform";
import { ui } from "../../ui";

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
	const lambdasDir = join(cwd, "src/lambdas");
	const terraformDir = join(cwd, "terraform");

	if (!existsSync(lambdasDir)) {
		mkdirSync(lambdasDir, { recursive: true });
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

	// Create example lambda (only if no lambda files exist)
	const exampleLambdaPath = join(lambdasDir, "hello.ts");
	if (!info.hasLambdaFiles) {
		await writeFile(exampleLambdaPath, exampleLambdaTemplate(), result, false);
	}

	// Handle Terraform files
	await scaffoldTerraform(cwd, info, answers.name, result);

	return result;
}

/**
 * Scaffold Terraform files with smart appending
 */
async function scaffoldTerraform(
	cwd: string,
	info: ProjectInfo,
	name: string,
	result: ScaffoldResult,
): Promise<void> {
	const tfDir = join(cwd, "terraform");

	// providers.tf
	const providersPath = join(tfDir, "providers.tf");
	if (info.terraformFiles.providers) {
		const existing = await readFileOrEmpty(providersPath);
		const updated = appendProviders(existing);
		if (updated !== existing) {
			await writeFile(providersPath, updated, result, true);
		} else {
			result.skipped.push(providersPath);
		}
	} else {
		await writeFile(providersPath, tfTemplates.providers, result, false);
	}

	// variables.tf
	const variablesPath = join(tfDir, "variables.tf");
	if (info.terraformFiles.variables) {
		const existing = await readFileOrEmpty(variablesPath);
		const updated = getMissingVariables(existing, name);
		if (updated !== existing) {
			await writeFile(variablesPath, updated, result, true);
		} else {
			result.skipped.push(variablesPath);
		}
	} else {
		await writeFile(variablesPath, tfTemplates.variables(name), result, false);
	}

	// main.tf
	const mainPath = join(tfDir, "main.tf");
	if (info.terraformFiles.main) {
		const existing = await readFileOrEmpty(mainPath);
		const updated = appendMain(existing);
		if (updated !== existing) {
			await writeFile(mainPath, updated, result, true);
		} else {
			result.skipped.push(mainPath);
		}
	} else {
		await writeFile(mainPath, tfTemplates.main, result, false);
	}

	// outputs.tf
	const outputsPath = join(tfDir, "outputs.tf");
	if (info.terraformFiles.outputs) {
		const existing = await readFileOrEmpty(outputsPath);
		const updated = appendOutputs(existing);
		if (updated !== existing) {
			await writeFile(outputsPath, updated, result, true);
		} else {
			result.skipped.push(outputsPath);
		}
	} else {
		await writeFile(outputsPath, tfTemplates.outputs, result, false);
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

	ui.info("Installing dependencies...");

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

	ui.success("Dependencies installed");
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
	ui.blank();

	for (const path of result.created) {
		ui.success(`Created ${getRelativePath(cwd, path)}`);
	}

	for (const path of result.updated) {
		ui.success(`Updated ${getRelativePath(cwd, path)}`);
	}

	// Don't print skipped files - too noisy
}
