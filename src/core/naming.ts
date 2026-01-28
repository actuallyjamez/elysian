/**
 * Lambda naming utilities
 */

/**
 * Generate Lambda bundle name with API name prefix
 * Format: {name}-{lambdaName}
 */
export function getLambdaBundleName(name: string, lambdaName: string): string {
	return `${name}-${lambdaName}`;
}

/**
 * Extract original lambda name from bundle name
 * Reverses getLambdaBundleName()
 */
export function getOriginalLambdaName(name: string, bundleName: string): string {
	const prefix = `${name}-`;
	if (bundleName.startsWith(prefix)) {
		return bundleName.slice(prefix.length);
	}
	return bundleName;
}
