/**
 * Init module exports
 */

export { detectProject, type ProjectInfo, type PackageManager } from "./detect";
export {
	runFreshProjectWizard,
	runExistingProjectWizard,
	type WizardAnswers,
} from "./prompts";
export {
	scaffoldProject,
	installDependencies,
	printResults,
	type ScaffoldResult,
} from "./scaffold";
