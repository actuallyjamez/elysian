/**
 * Wizard prompts using consola.prompt
 */

import consola from "consola";
import type { PackageManager } from "./detect";
import { printBlank } from "../../logger";

export interface WizardAnswers {
	targetDir: string;
	name: string;
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
 * Run the initial wizard to get the target directory
 * Returns the target directory path, or null if cancelled
 */
export async function promptTargetDirectory(
	currentDirName: string,
): Promise<string | null> {
	printBlank();

	const targetDir = await consola.prompt("Where would you like to create your project?", {
		type: "text",
		default: ".",
		placeholder: ". (current directory)",
		cancel: "symbol",
	});

	if (isCancelled(targetDir)) {
		return null;
	}

	return targetDir as string;
}

/**
 * Run wizard for a fresh (empty) project
 */
export async function runFreshProjectWizard(
	apiName: string,
): Promise<Omit<WizardAnswers, "targetDir"> | null> {
	consola.info(`Creating new elysian project: ${apiName}\n`);

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
		name: apiName,
		packageManager: packageManager as PackageManager,
		installDeps: true, // Always install for fresh projects
	};
}

/**
 * Run wizard for an existing project
 */
export async function runExistingProjectWizard(
	apiName: string,
	detectedPackageManager: PackageManager | null,
): Promise<Omit<WizardAnswers, "targetDir"> | null> {
	consola.info(`Adding elysian to: ${apiName}\n`);

	// Use detected package manager or prompt
	let packageManager: PackageManager;
	if (detectedPackageManager) {
		packageManager = detectedPackageManager;
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
		name: apiName,
		packageManager,
		installDeps: installDeps as boolean,
	};
}
