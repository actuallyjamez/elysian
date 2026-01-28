# elysian

> Automatic Lambda bundler for [Elysia](https://elysiajs.com/) with AWS API Gateway and Terraform integration.

## Features

- **Zero-config Lambda handlers** - Just export your Elysia routes as default, handlers are auto-generated
- **Interactive init wizard** - Sets up fresh or existing projects with smart defaults
- **Package manager detection** - Automatically detects bun/npm/pnpm/yarn from lockfiles
- **Automatic OpenAPI aggregation** - All routes are aggregated into a single OpenAPI spec endpoint
- **Smart Terraform integration** - Generates modular Terraform files that won't overwrite your existing config
- **Type-safe configuration** - Full TypeScript support with `defineConfig()`
- **Watch mode** - Fast rebuilds during development

## Installation

```bash
# With bun (recommended)
bun add elysia @actuallyjamez/elysian

# With npm
npm install elysia @actuallyjamez/elysian

# With pnpm
pnpm add elysia @actuallyjamez/elysian

# With yarn
yarn add elysia @actuallyjamez/elysian
```

## Quick Start

### 1. Initialize your project

```bash
# Interactive wizard - prompts for everything you need
elysian init
```

The wizard will:
- Ask where to create the project (default: current directory)
- Detect your package manager automatically
- Create all necessary files
- Install dependencies (fresh projects only)

**Fresh project example:**
```
? Where would you like to create your project? my-api
✔ Created directory: my-api

ℹ Creating new elysian project: my-api

? Package manager: bun
✔ Created package.json
✔ Created elysian.config.ts
✔ Created src/lambdas/hello.ts
✔ Created terraform/providers.tf
...
```

**Existing project example:**
```
ℹ Adding elysian to: my-existing-app

ℹ Detected package manager: bun
? Install dependencies? Yes
✔ Created elysian.config.ts
✔ Updated terraform/variables.tf
...
```

### 2. Write your lambdas

```typescript
// src/lambdas/users.ts
import { createLambda, t } from "@actuallyjamez/elysian";

export default createLambda()
  .get("/users", () => db.getUsers(), {
    response: t.Array(t.Object({ id: t.String(), name: t.String() })),
    detail: { summary: "List all users", tags: ["Users"] },
  })
  .get("/users/:id", ({ params }) => db.getUser(params.id), {
    params: t.Object({ id: t.String() }),
    detail: { summary: "Get user by ID", tags: ["Users"] },
  })
  .post("/users", ({ body }) => db.createUser(body), {
    body: t.Object({ name: t.String(), email: t.String() }),
    detail: { summary: "Create user", tags: ["Users"] },
  });
```

**That's it!** No need to export a handler - bundler wraps your default export automatically.

### 3. Build

```bash
# Development build
elysian build

# Production build (minified)
elysian build --prod
```

### 4. Deploy

```bash
cd terraform
terraform init
terraform apply
```

## Configuration

Create `elysian.config.ts` in your project root:

```typescript
import { defineConfig } from "@actuallyjamez/elysian";

export default defineConfig({
  // Required: Used for naming your AWS resources
  name: "my-api",

  // Optional: Lambda source directory (default: "src/lambdas")
  lambdasDir: "src/lambdas",

  // Optional: Build output directory (default: "dist")
  outputDir: "dist",

  // Optional: OpenAPI configuration (default: enabled)
  // Note: title and version have smart defaults
  openapi: {
    enabled: true,
    // title defaults to `name` if not provided
    // version defaults to package.json version if not provided
    description: "API description",
  },

  // Optional: Terraform output directory (default: "terraform")
  terraform: {
    outputDir: "terraform",
  },

  // Optional: Lambda defaults
  lambda: {
    runtime: "nodejs22.x",
    memorySize: 256,
    timeout: 30,
  },
});
```

## CLI Commands

### `elysian init`

Interactive wizard to initialize a new elysian project.

```bash
# Initialize in current directory
elysian init

# Initialize in subdirectory (creates it if needed)
elysian init
# Answer: my-new-api

# Force overwrite existing files
elysian init --force
```

**What it creates (fresh project):**
- `package.json` - With build scripts
- `tsconfig.json` - TypeScript configuration
- `.gitignore` - Ignores node_modules, dist, terraform state
- `elysian.config.ts` - Elysian configuration
- `src/lambdas/hello.ts` - Example lambda
- `terraform/providers.tf` - AWS provider configuration
- `terraform/variables.tf` - Terraform variables
- `terraform/main.tf` - Lambda and API Gateway resources
- `terraform/outputs.tf` - API endpoint output

**What it does (existing project):**
- Detects package manager from lockfiles
- Creates `elysian.config.ts` (doesn't overwrite if exists)
- Creates example lambda only if no `.ts` files in `src/lambdas/`
- Smart-appends to existing Terraform files (won't overwrite your config)

### `elysian build`

Build all lambdas for deployment.

```bash
# Development build
elysian build

# Production build (minified, no sourcemaps)
elysian build --prod
```

**Output:**
- `dist/*.js` - Bundled lambda code
- `dist/*.zip` - Lambda deployment packages
- `dist/manifest.json` - Route manifest (for debugging)

### `elysian dev`

Watch mode for development - rebuilds on file changes.

```bash
# Watch with packaging
elysian dev

# Watch without zip creation (faster)
elysian dev --no-package
```

### `elysian generate-iac`

Regenerate Terraform files without rebuilding lambdas.

```bash
elysian generate-iac
```

**Smart Terraform file handling:**
- `providers.tf` - Adds AWS provider if missing
- `variables.tf` - Adds missing variables only
- `main.tf` - Adds Lambda/API Gateway resources if missing
- `outputs.tf` - Adds API endpoint output if missing

## How It Works

### 1. Route Discovery

The bundler scans your `lambdasDir` for `.ts` files. Each file becomes a separate Lambda function.

```
src/lambdas/
├── users.ts    → users.zip → AWS Lambda (users-api)
├── posts.ts    → posts.zip → AWS Lambda (posts-api)
└── auth.ts     → auth.zip  → AWS Lambda (auth-api)
```

### 2. Handler Injection

When you export an Elysia app as default:

```typescript
export default createLambda().get("/hello", () => "Hello!");
```

The bundler automatically wraps it with a Lambda handler:

```typescript
import { Hono } from "hono/tiny";
import { handle } from "hono/aws-lambda";

const app = /* your exported app */;
export const handler = handle(new Hono().mount("/", app.fetch));
```

### 3. OpenAPI Aggregation

An `__openapi__` lambda is automatically generated that imports all your routes and exposes:
- `GET /openapi` - Swagger UI
- `GET /openapi/json` - OpenAPI JSON spec

### 4. Terraform Integration

The generated Terraform files are modular and won't overwrite your existing configuration:

- **providers.tf** - AWS provider with version `~> 6.0`
- **variables.tf** - All variables (region, lambda config, routes)
- **main.tf** - API Gateway, Lambda, IAM resources
- **outputs.tf** - API endpoint URL

The `terraform/api-routes.auto.tfvars` file is auto-generated on each build with:
- List of Lambda names
- Route-to-Lambda mappings (with API Gateway path format)
- Lambda configuration defaults

## Project Structure

```
my-api/
├── elysian.config.ts         # Configuration
├── package.json              # Dependencies & scripts
├── tsconfig.json            # TypeScript config
├── .gitignore               # Git ignore patterns
├── src/
│   └── lambdas/
│       ├── users.ts          # → my-api-users.zip Lambda
│       ├── posts.ts          # → my-api-posts.zip Lambda
│       └── auth.ts           # → my-api-auth.zip Lambda
├── dist/                    # Build output
│   ├── my-api-users.js
│   ├── my-api-users.zip
│   ├── my-api-posts.js
│   ├── my-api-posts.zip
│   ├── __openapi__.js       # Auto-generated
│   ├── __openapi__.zip
│   └── manifest.json
└── terraform/
    ├── providers.tf          # AWS provider
    ├── variables.tf         # Terraform variables
    ├── main.tf             # Resources (Lambda, API Gateway, IAM)
    ├── outputs.tf          # Outputs
    └── api-routes.auto.tfvars  # Auto-generated on build
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Elysia](https://elysiajs.com/) v1.0+

## License

MIT
