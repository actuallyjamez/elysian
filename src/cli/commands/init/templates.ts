/**
 * Template strings for generated files
 */

/**
 * elysian.config.ts template
 */
export function configTemplate(name: string): string {
	return `import { defineConfig } from "@actuallyjamez/elysian";

export default defineConfig({
	name: "${name}",
});
`;
}

/**
 * Example API route template using defineRoutes()
 */
export function exampleApiRouteTemplate(): string {
	return `import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
	.get("/", ({ query }) => {
		return \`Hello, \${query.name ?? "Elysian"}!\`;
	}, {
		response: t.String(),
		query: t.Object({
			name: t.Optional(t.String()),
		}),
		detail: {
			summary: "Say hello",
			tags: ["Greeting"],
		},
	});
`;
}

/**
 * Example generic lambda template using defineLambda()
 */
export function exampleGenericLambdaTemplate(): string {
	return `import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
	trigger: "sqs",
	handler: async (event) => {
		for (const record of event.Records) {
			const body = JSON.parse(record.body);
			console.log("Processing message:", body);
			// Add your processing logic here
		}
	},
});
`;
}

/**
 * @deprecated Use exampleApiRouteTemplate instead
 */
export function exampleLambdaTemplate(): string {
	return exampleApiRouteTemplate();
}

/**
 * package.json template for fresh projects
 */
export function packageJsonTemplate(name: string): string {
	return JSON.stringify(
		{
			name: name,
			version: "0.1.0",
			type: "module",
			scripts: {
				build: "elysian build",
				dev: "elysian dev",
			},
		},
		null,
		2,
	);
}

/**
 * .gitignore template
 */
export function gitignoreTemplate(): string {
	return `# Dependencies
node_modules/

# Build output
dist/

# Environment
.env
.env.local

# Terraform
terraform/.terraform/
terraform/*.tfstate
terraform/*.tfstate.backup
terraform/.terraform.lock.hcl

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`;
}

/**
 * tsconfig.json template
 */
export function tsconfigTemplate(): string {
	return JSON.stringify(
		{
			compilerOptions: {
				target: "ESNext",
				module: "ESNext",
				moduleResolution: "bundler",
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				noEmit: true,
				types: ["@types/node"],
			},
			include: ["src/**/*", "elysian.config.ts"],
			exclude: ["node_modules", "dist"],
		},
		null,
		2,
	);
}

/**
 * Ensure package.json has required fields (name, version, scripts)
 * Returns the updated content if changes were made, or null if no changes needed
 */
export function ensurePackageJsonFields(
	existingContent: string,
	name: string,
): string | null {
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(existingContent);
	} catch {
		// Invalid JSON, can't update
		return null;
	}

	let changed = false;

	// Ensure name
	if (!pkg.name) {
		pkg.name = name;
		changed = true;
	}

	// Ensure version
	if (!pkg.version) {
		pkg.version = "0.1.0";
		changed = true;
	}

	// Ensure type is module
	if (!pkg.type) {
		pkg.type = "module";
		changed = true;
	}

	// Ensure scripts exist with elysian commands
	const scripts = (pkg.scripts as Record<string, string>) || {};
	if (!scripts.build) {
		scripts.build = "elysian build";
		changed = true;
	}
	if (!scripts.dev) {
		scripts.dev = "elysian dev";
		changed = true;
	}
	if (changed || !pkg.scripts) {
		pkg.scripts = scripts;
	}

	if (!changed) {
		return null;
	}

	// Reorder keys to put name, version, type, scripts first
	const ordered: Record<string, unknown> = {};
	if (pkg.name) ordered.name = pkg.name;
	if (pkg.version) ordered.version = pkg.version;
	if (pkg.type) ordered.type = pkg.type;
	if (pkg.scripts) ordered.scripts = pkg.scripts;

	// Add remaining keys
	for (const [key, value] of Object.entries(pkg)) {
		if (!ordered[key]) {
			ordered[key] = value;
		}
	}

	return JSON.stringify(ordered, null, 2);
}
