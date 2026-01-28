# elysian

Automatic Lambda bundler for [Elysia](https://elysiajs.com/) with AWS API Gateway and Terraform integration.

## Features

- **Zero-config Lambda handlers** - Just export your Elysia routes as default, handlers are auto-generated
- **Automatic OpenAPI aggregation** - All routes are aggregated into a single OpenAPI spec endpoint
- **Terraform integration** - Generates `tfvars` files for seamless infrastructure deployment
- **Type-safe configuration** - Full TypeScript support with `defineConfig()`
- **Watch mode** - Fast rebuilds during development

## Installation

```bash
# Configure GitHub registry for @actuallyjamez scope
echo "@actuallyjamez:registry=https://npm.pkg.github.com" >> .npmrc

# Install
bun add elysia @actuallyjamez/elysian
```

## Quick Start

### 1. Initialize your project

```bash
bunx @actuallyjamez/elysian init --name my-api
```

This creates:
- `elysian.config.ts` - Configuration file
- `src/lambdas/hello.ts` - Example lambda
- `terraform/main.tf` - Terraform infrastructure

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

**That's it!** No need to export a handler - the bundler wraps your default export automatically.

### 3. Build

```bash
# Development build
bunx elysian build

# Production build (minified)
bunx elysian build --prod
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
  // Required
  apiName: "my-api",

  // Optional (showing defaults)
  lambdasDir: "src/lambdas",
  outputDir: "dist",

  // OpenAPI configuration
  openapi: {
    enabled: true,
    title: "My API",
    version: "1.0.0",
    description: "API description",
  },

  // Terraform output configuration
  terraform: {
    outputDir: "terraform",
    tfvarsFilename: "api-routes.auto.tfvars", // Won't overwrite your existing tfvars
  },

  // Lambda defaults (used in generated tfvars)
  lambda: {
    runtime: "nodejs20.x",
    memorySize: 256,
    timeout: 30,
  },
});
```

## CLI Commands

### `elysian build`

Build all lambdas for deployment.

```bash
bunx elysian build          # Development build
bunx elysian build --prod   # Production build (minified)
```

**Output:**
- `dist/*.js` - Bundled lambda code
- `dist/*.zip` - Lambda deployment packages
- `dist/manifest.json` - Route manifest (for debugging)
- `terraform/api-routes.auto.tfvars` - Terraform variables

### `elysian dev`

Watch mode for development - rebuilds on file changes.

```bash
bunx elysian dev              # Watch with packaging
bunx elysian dev --no-package # Skip zip creation (faster)
```

### `elysian init`

Initialize a new project with example files.

```bash
bunx elysian init --name my-api
bunx elysian init --force  # Overwrite existing files
```

### `elysian generate-iac`

Regenerate Terraform files without rebuilding lambdas.

```bash
bunx elysian generate-iac
```

## How It Works

### 1. Route Discovery

The bundler scans your `lambdasDir` for `.ts` files. Each file becomes a separate Lambda function.

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

The generated `tfvars` file contains:
- List of Lambda names
- Route-to-Lambda mappings (with API Gateway path format)
- Lambda configuration defaults

## Project Structure

```
my-api/
├── elysian.config.ts         # Configuration
├── src/
│   └── lambdas/
│       ├── users.ts          # → users.zip Lambda
│       ├── posts.ts          # → posts.zip Lambda
│       └── auth.ts           # → auth.zip Lambda
├── dist/                     # Build output
│   ├── users.js
│   ├── users.zip
│   ├── posts.js
│   ├── posts.zip
│   ├── __openapi__.js        # Auto-generated
│   ├── __openapi__.zip
│   └── manifest.json
└── terraform/
    ├── main.tf
    └── api-routes.auto.tfvars  # Auto-generated
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Elysia](https://elysiajs.com/) v1.0+

## License

MIT
