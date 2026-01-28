/**
 * Package version - read from package.json
 */

import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let version = "0.0.0";

try {
	// Try to read version from package.json
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const require = createRequire(import.meta.url);
	const pkg = require(join(__dirname, "../../package.json"));
	version = pkg.version;
} catch {
	// Fallback if package.json can't be read
}

export { version };
