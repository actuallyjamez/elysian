/**
 * Naming utilities for lambda bundles
 */

/**
 * Generate the prefixed lambda name for bundle files
 * Format: {apiName}-{lambdaName}
 */
export function getLambdaBundleName(apiName: string, lambdaName: string): string {
	return `${apiName}-${lambdaName}`;
}

/**
 * Extract the original lambda name from a prefixed bundle name
 */
export function getOriginalLambdaName(apiName: string, bundleName: string): string {
	const prefix = `${apiName}-`;
	if (bundleName.startsWith(prefix)) {
		return bundleName.slice(prefix.length);
	}
	return bundleName;
}
