/**
 * Lambda packager - creates zip files for AWS Lambda deployment
 */

import { execSync } from "child_process";
import { join, dirname } from "path";
import { mkdirSync, rmSync, existsSync, copyFileSync } from "fs";

export interface PackageResult {
	name: string;
	zipPath: string;
	success: boolean;
	error?: string;
}

/**
 * Package a bundled lambda into a zip file
 */
export async function packageLambda(
	name: string,
	jsFilePath: string,
	outputDir: string,
): Promise<PackageResult> {
	const lambdaDir = join(outputDir, `__${name}_pkg__`);
	const zipPath = join(outputDir, `${name}.zip`);

	try {
		// Create temp directory for packaging
		mkdirSync(lambdaDir, { recursive: true });

		// Copy JS file as index.mjs (Lambda expects this name)
		copyFileSync(jsFilePath, join(lambdaDir, "index.mjs"));

		// Create zip file
		execSync(`zip -qj "${zipPath}" "${join(lambdaDir, "index.mjs")}"`, {
			cwd: outputDir,
		});

		// Clean up temp directory
		rmSync(lambdaDir, { recursive: true, force: true });

		return {
			name,
			zipPath,
			success: true,
		};
	} catch (error) {
		// Clean up on error
		if (existsSync(lambdaDir)) {
			rmSync(lambdaDir, { recursive: true, force: true });
		}

		return {
			name,
			zipPath,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Package all bundled lambdas
 */
export async function packageAllLambdas(
	lambdaNames: string[],
	outputDir: string,
): Promise<PackageResult[]> {
	const results: PackageResult[] = [];

	for (const name of lambdaNames) {
		const jsFilePath = join(outputDir, `${name}.js`);
		const result = await packageLambda(name, jsFilePath, outputDir);
		results.push(result);
	}

	return results;
}
