/**
 * Init command - Interactive wizard to initialize elysian projects
 */

import { defineCommand } from "citty";
import consola from "consola";
import {
	detectProject,
	runFreshProjectWizard,
	runExistingProjectWizard,
	scaffoldProject,
	installDependencies,
	printResults,
} from "./init/index";

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
		const cwd = process.cwd();

		// Detect project state
		const info = await detectProject(cwd);

		// Check for existing config (unless force)
		if (info.hasElysianConfig && !args.force) {
			consola.error(
				"elysian.config.ts already exists. Use --force to overwrite.",
			);
			process.exit(1);
		}

		// Run appropriate wizard
		const answers = info.isEmpty
			? await runFreshProjectWizard(info)
			: await runExistingProjectWizard(info);

		// User cancelled
		if (!answers) {
			consola.info("Cancelled");
			process.exit(0);
		}

		// Scaffold files
		const result = await scaffoldProject(cwd, info, answers, args.force);

		// Print results
		printResults(cwd, result);

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

		consola.box(
			"Project initialized!\n\n" +
				"Next steps:\n\n" +
				(answers.installDeps ? "" : `1. ${pm} add elysia @actuallyjamez/elysian\n\n`) +
				`${answers.installDeps ? "1" : "2"}. ${runCmd} elysian build\n\n` +
				`${answers.installDeps ? "2" : "3"}. cd terraform && terraform init && terraform apply`,
		);
	},
});
