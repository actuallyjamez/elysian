/**
 * Init command - Interactive wizard to initialize elysian projects
 */

import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, mkdirSync } from "fs";
import { resolve, basename } from "path";
import {
	detectProject,
	type ProjectInfo,
} from "./init/detect";
import {
	promptTargetDirectory,
	runFreshProjectWizard,
	runExistingProjectWizard,
	type WizardAnswers,
} from "./init/prompts";
import {
	scaffoldProject,
	installDependencies,
	printResults,
} from "./init/scaffold";

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description: "Initialize a new elysian project",
	},
	args: {
		force: {
			type: "boolean",
			description: "Overwrite existing files",
			default: false,
		},
	},
	async run({ args }) {
		const originalCwd = process.cwd();

		// Step 1: Get target directory
		const targetDir = await promptTargetDirectory(basename(originalCwd));
		if (!targetDir) {
			consola.info("Cancelled");
			process.exit(0);
		}

		// Resolve the target directory
		const cwd = resolve(originalCwd, targetDir);
		const apiName = basename(cwd);

		// Create directory if it doesn't exist
		if (!existsSync(cwd)) {
			mkdirSync(cwd, { recursive: true });
			consola.success(`Created directory: ${targetDir}`);
		}

		// Detect project state in target directory
		const info = await detectProject(cwd);

		// Check for existing config (unless force)
		if (info.hasElysianConfig && !args.force) {
			consola.error(
				"elysian.config.ts already exists. Use --force to overwrite.",
			);
			process.exit(1);
		}

		// Run appropriate wizard based on whether directory is empty
		let answers: WizardAnswers | null;

		if (info.isEmpty) {
			const result = await runFreshProjectWizard(apiName);
			if (!result) {
				consola.info("Cancelled");
				process.exit(0);
			}
			answers = {
				targetDir,
				apiName,
				...result,
			};
		} else {
			const result = await runExistingProjectWizard(apiName, info.packageManager);
			if (!result) {
				consola.info("Cancelled");
				process.exit(0);
			}
			answers = {
				targetDir,
				apiName,
				...result,
			};
		}

		// Scaffold files
		const scaffoldResult = await scaffoldProject(cwd, info, answers, args.force);

		// Print results
		printResults(cwd, scaffoldResult);

		// Install dependencies if requested
		if (answers.installDeps) {
			try {
				await installDependencies(cwd, answers.packageManager);
			} catch (error) {
				consola.error(
					error instanceof Error ? error.message : "Failed to install dependencies",
				);
				consola.info(
					`You can manually install with: ${answers.packageManager} add elysia @actuallyjamez/elysian`,
				);
			}
		}

		// Print next steps
		console.log("");
		const pm = answers.packageManager;
		const runCmd = pm === "npm" ? "npm run" : pm;

		// If we created in a subdirectory, tell user to cd into it
		const cdStep = targetDir !== "." ? `cd ${targetDir}\n\n` : "";

		consola.box(
			"Project initialized!\n\n" +
				"Next steps:\n\n" +
				cdStep +
				(answers.installDeps ? "" : `${pm} add elysia @actuallyjamez/elysian\n\n`) +
				`${runCmd} elysian build\n\n` +
				"cd terraform && terraform init && terraform apply",
		);
	},
});
