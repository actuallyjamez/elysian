/**
 * Package version - read from jsr.json or package.json
 */

import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let version = "0.0.0";

try {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const require = createRequire(import.meta.url);
	
	// Try jsr.json first (for JSR published package - src/core/version.ts -> ../../jsr.json)
	try {
		const jsr = require(join(__dirname, "../../jsr.json"));
		version = jsr.version;
	} catch {
		// Try package.json (for npm/local - dist/core/version.js -> ../../package.json)
		try {
			const pkg = require(join(__dirname, "../../package.json"));
			version = pkg.version;
		} catch {
			// Fallback already set to 0.0.0
		}
	}
} catch {
	// Fallback if nothing works
}

export { version };
