/**
 * Init command - Interactive wizard to initialize elysian projects
 */

import { defineCommand } from "citty";
import { existsSync, mkdirSync } from "fs";
import { resolve, basename } from "path";
import {
	detectProject,
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
import {
	logger,
	printHeader,
	printSection,
	printBlank,
} from "../logger";

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
		printHeader();

		const originalCwd = process.cwd();

		// Step 1: Get target directory
		const targetDir = await promptTargetDirectory(basename(originalCwd));
		if (!targetDir) {
			logger.info("Cancelled");
			process.exit(0);
		}

		// Resolve the target directory
		const cwd = resolve(originalCwd, targetDir);
		const name = basename(cwd);

		// Create directory if it doesn't exist
		if (!existsSync(cwd)) {
			mkdirSync(cwd, { recursive: true });
			logger.success(`Created directory: ${targetDir}`);
		}

		// Detect project state in target directory
		const info = await detectProject(cwd);

		// Check for existing config (unless force)
		if (info.hasElysianConfig && !args.force) {
			logger.error("elysian.config.ts already exists. Use --force to overwrite.");
			process.exit(1);
		}

		// Run appropriate wizard based on whether directory is empty
		let answers: WizardAnswers | null;

		if (info.isEmpty) {
			const result = await runFreshProjectWizard(name);
			if (!result) {
				logger.info("Cancelled");
				process.exit(0);
			}
			answers = {
				targetDir,
				...result,
			};
		} else {
			const result = await runExistingProjectWizard(name, info.packageManager);
			if (!result) {
				logger.info("Cancelled");
				process.exit(0);
			}
			answers = {
				targetDir,
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
				logger.error(
					error instanceof Error ? error.message : "Failed to install dependencies",
				);
				logger.info(
					`You can manually install with: ${answers.packageManager} add elysia @actuallyjamez/elysian`,
				);
			}
		}

		// Print next steps
		printBlank();
		const pm = answers.packageManager;
		// const runCmd = pm === "npm" ? "npm run" : pm;

		logger.success("Project initialized!");
		printBlank();
		printSection("Next steps");

		// If we created in a subdirectory, tell user to cd into it
		if (targetDir !== ".") {
			console.log(`    cd ${targetDir}`);
			printBlank();
		}

		if (!answers.installDeps) {
			console.log(`    ${pm} add elysia @actuallyjamez/elysian`);
			printBlank();
		}

		console.log(`    ${pm} elysian dev`);
		printBlank();
	},
});
