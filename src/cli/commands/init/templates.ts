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
 * Example lambda template
 */
export function exampleLambdaTemplate(): string {
	return `import { createLambda, t } from "@actuallyjamez/elysian";

export default createLambda()
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
				types: ["bun-types"],
			},
			include: ["src/**/*", "elysian.config.ts"],
			exclude: ["node_modules", "dist"],
		},
		null,
		2,
	);
}
