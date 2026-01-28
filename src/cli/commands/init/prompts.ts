/**
 * Wizard prompts using consola.prompt
 */

import consola from "consola";
import type { PackageManager, ProjectInfo } from "./detect";

export interface WizardAnswers {
	apiName: string;
	packageManager: PackageManager;
	installDeps: boolean;
}

const CANCEL_SYMBOL = Symbol.for("cancel");

/**
 * Check if user cancelled the prompt
 */
function isCancelled(value: unknown): boolean {
	return value === CANCEL_SYMBOL;
}

/**
 * Run wizard for a fresh (empty) project
 */
export async function runFreshProjectWizard(
	info: ProjectInfo,
): Promise<WizardAnswers | null> {
	console.log("");
	consola.info("Creating a new elysian project...\n");

	// Prompt for API name
	const apiName = await consola.prompt("API name:", {
		type: "text",
		default: info.directoryName,
		placeholder: info.directoryName,
		cancel: "symbol",
	});

	if (isCancelled(apiName)) {
		return null;
	}

	// Prompt for package manager
	const packageManager = await consola.prompt("Package manager:", {
		type: "select",
		options: [
			{ value: "bun", label: "bun", hint: "recommended" },
			{ value: "npm", label: "npm" },
			{ value: "pnpm", label: "pnpm" },
			{ value: "yarn", label: "yarn" },
		],
		cancel: "symbol",
	});

	if (isCancelled(packageManager)) {
		return null;
	}

	return {
		apiName: apiName as string,
		packageManager: packageManager as PackageManager,
		installDeps: true, // Always install for fresh projects
	};
}

/**
 * Run wizard for an existing project
 */
export async function runExistingProjectWizard(
	info: ProjectInfo,
): Promise<WizardAnswers | null> {
	console.log("");
	consola.info("Adding elysian to existing project...\n");

	// Use package.json name as default, fallback to directory name
	const defaultName = info.packageName || info.directoryName;

	// Prompt for API name
	const apiName = await consola.prompt("API name:", {
		type: "text",
		default: defaultName,
		placeholder: defaultName,
		cancel: "symbol",
	});

	if (isCancelled(apiName)) {
		return null;
	}

	// Use detected package manager or prompt
	let packageManager: PackageManager;
	if (info.packageManager) {
		packageManager = info.packageManager;
		consola.info(`Detected package manager: ${packageManager}`);
	} else {
		const selected = await consola.prompt("Package manager:", {
			type: "select",
			options: [
				{ value: "bun", label: "bun", hint: "recommended" },
				{ value: "npm", label: "npm" },
				{ value: "pnpm", label: "pnpm" },
				{ value: "yarn", label: "yarn" },
			],
			cancel: "symbol",
		});

		if (isCancelled(selected)) {
			return null;
		}
		packageManager = selected as PackageManager;
	}

	// Prompt whether to install dependencies
	const installDeps = await consola.prompt("Install dependencies?", {
		type: "confirm",
		initial: true,
		cancel: "symbol",
	});

	if (isCancelled(installDeps)) {
		return null;
	}

	return {
		apiName: apiName as string,
		packageManager,
		installDeps: installDeps as boolean,
	};
}
