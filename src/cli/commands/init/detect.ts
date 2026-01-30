/**
 * Detection utilities for init wizard
 */

import { existsSync, readdirSync } from "fs";
import { join, basename } from "path";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface ProjectInfo {
	/** Whether the directory is empty (only hidden files allowed) */
	isEmpty: boolean;
	/** Detected package manager from lockfile, or null */
	packageManager: PackageManager | null;
	/** Name from package.json, or null */
	packageName: string | null;
	/** Whether elysian.config.ts exists */
	hasElysianConfig: boolean;
	/** Whether terraform/ directory exists */
	hasTerraformDir: boolean;
	/** Existing terraform files */
	terraformFiles: {
		providers: boolean;
		variables: boolean;
		main: boolean;
		outputs: boolean;
	};
	/** Whether src/functions/ exists */
	hasFunctionsDir: boolean;
	/** Whether there are any .ts files in src/functions/ */
	hasLambdaFiles: boolean;
	/** Directory name (for default name) */
	directoryName: string;
}

/**
 * Check if a directory is empty (ignoring hidden files like .git)
 */
function isDirectoryEmpty(cwd: string): boolean {
	try {
		const files = readdirSync(cwd);
		// Filter out hidden files (starting with .)
		const visibleFiles = files.filter((f) => !f.startsWith("."));
		return visibleFiles.length === 0;
	} catch {
		return true;
	}
}

/**
 * Detect package manager from lockfiles
 */
function detectPackageManager(cwd: string): PackageManager | null {
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
		return "bun";
	}
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (existsSync(join(cwd, "yarn.lock"))) {
		return "yarn";
	}
	if (existsSync(join(cwd, "package-lock.json"))) {
		return "npm";
	}
	return null;
}

/**
 * Read package name from package.json
 */
async function readPackageName(cwd: string): Promise<string | null> {
	const packagePath = join(cwd, "package.json");
	if (!existsSync(packagePath)) {
		return null;
	}
	try {
		const content = await Bun.file(packagePath).json();
		return content.name || null;
	} catch {
		return null;
	}
}

/**
 * Check which terraform files exist
 */
function checkTerraformFiles(cwd: string): ProjectInfo["terraformFiles"] {
	const tfDir = join(cwd, "terraform");
	return {
		providers: existsSync(join(tfDir, "providers.tf")),
		variables: existsSync(join(tfDir, "variables.tf")),
		main: existsSync(join(tfDir, "main.tf")),
		outputs: existsSync(join(tfDir, "outputs.tf")),
	};
}

/**
 * Check if there are any .ts files in the lambdas directory
 */
function hasLambdaFiles(cwd: string): boolean {
	const functionsDir = join(cwd, "src/functions");
	if (!existsSync(functionsDir)) {
		return false;
	}

	try {
		const files = readdirSync(functionsDir);
		return files.some((f) => f.endsWith(".ts"));
	} catch {
		return false;
	}
}

/**
 * Gather all project information for the init wizard
 */
export async function detectProject(cwd: string): Promise<ProjectInfo> {
	const packageName = await readPackageName(cwd);

	return {
		isEmpty: isDirectoryEmpty(cwd),
		packageManager: detectPackageManager(cwd),
		packageName,
		hasElysianConfig: existsSync(join(cwd, "elysian.config.ts")),
		hasTerraformDir: existsSync(join(cwd, "terraform")),
		terraformFiles: checkTerraformFiles(cwd),
		hasFunctionsDir: existsSync(join(cwd, "src/functions")),
		hasLambdaFiles: hasLambdaFiles(cwd),
		directoryName: basename(cwd),
	};
}
