# elysian

> Automatic Lambda bundler for [Elysia](https://elysiajs.com/) with AWS API Gateway and Terraform integration.

Elysian simplifies deploying Elysia.js applications to AWS Lambda. Write your application logic while elysian handles bundling, handlers, and infrastructure. Each file in `src/api/` becomes a separate Lambda with its own API Gateway endpoint.

```bash
bunx @actuallyjamez/elysian init
```

---

## Installation

Elysian supports bun, npm, pnpm, and yarn. Bun is recommended for faster builds.

```bash
# bun (recommended)
bun add elysia @actuallyjamez/elysian

# npm
npm install elysia @actuallyjamez/elysian

# pnpm
pnpm add elysia @actuallyjamez/elysian

# yarn
yarn add elysia @actuallyjamez/elysian
```

---

## Quick Start

The fastest way to get started is with the init wizard. It detects your package manager, creates all necessary files, and sets up a working project.

```bash
bunx @actuallyjamez/elysian init
```

This creates a project structure like:

```
my-api/
├── elysian.config.ts    # Configuration
├── src/
│   ├── api/hello.ts     # Your first API route
│   └── functions/process-queue.ts  # Your first Lambda function
└── terraform/           # AWS infrastructure
```

After initialization, start the dev server to see changes live:

```bash
bun run dev
```

Define API routes in `src/api/` using `defineRoutes()`. Each file becomes a separate Lambda with its own API endpoint.

```typescript
// src/api/users.ts
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  .get("/users", () => db.users.findMany())
  .get("/users/:id", ({ params }) => db.users.findUnique(params.id))
  .post("/users", ({ body }) => db.users.create(body), {
    body: t.Object({ name: t.String(), email: t.String() }),
  });
```

Define event-driven Lambda functions in `src/functions/` using `defineLambda()`.

```typescript
// src/functions/process-queue.ts
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: "sqs",
  handler: async (event) => {
    for (const record of event.Records) {
      const body = JSON.parse(record.body);
      console.log("Processing:", body);
    }
  },
});
```

Build and deploy when ready:

```bash
elysian build
cd terraform
terraform init && terraform apply
```

---

## API Routes

Define HTTP endpoints in `src/api/`. Each file becomes a separate Lambda function with its own API Gateway endpoint. Since `defineRoutes()` returns an Elysia instance, you can use any Elysia plugins, state, decorators, or hooks.

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";
import { cors } from "@elysiajs/cors";

export default defineRoutes()
  .use(cors())
  .get("/hello", () => "Hello!")
  .get("/users", () => db.users.findMany())
  .get("/users/:id", ({ params }) => db.users.findUnique(params.id), {
    params: t.Object({ id: t.String() }),
  });
```

### HTTP Methods

All standard HTTP methods are supported for building RESTful APIs.

```typescript
export default defineRoutes()
  .get("/items", () => db.items.findMany())
  .post("/items", ({ body }) => db.items.create(body))
  .put("/items/:id", ({ params, body }) => db.items.update(params.id, body))
  .patch("/items/:id", ({ params, body }) => db.items.update(params.id, body))
  .delete("/items/:id", ({ params }) => db.items.delete(params.id));
```

### Request Types

Use Elysia's `t` utility to define typed request parameters.

```typescript
export default defineRoutes()
  .get("/users/:id", ({ params }) => {
    return db.users.findUnique(params.id);
  }, {
    params: t.Object({ id: t.String() }),
  })
  .get("/search", ({ query }) => {
    return db.items.findMany({ where: { name: { contains: query.q } } });
  }, {
    query: t.Object({ q: t.String() }),
  })
  .post("/users", ({ body }) => {
    return db.users.create(body);
  }, {
    body: t.Object({
      name: t.String(),
      email: t.String(),
      age: t.Optional(t.Number()),
    }),
  });
```

### Response Types

Define response schemas for OpenAPI documentation and type safety.

```typescript
export default defineRoutes()
  .get("/users", () => db.users.findMany(), {
    response: t.Array(t.Object({
      id: t.String(),
      name: t.String(),
      email: t.String(),
    })),
    detail: { summary: "List all users", tags: ["Users"] },
  });
```

### Elysia Features

Since `defineRoutes()` returns an Elysia instance, you have full access to the ecosystem.

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";
import { jwt } from "@elysiajs/jwt";
import { cookie } from "@elysiajs/cookie";

export default defineRoutes()
  .use(jwt({ secret: "secret" }))
  .use(cookie())
  .decorate("db", database)
  .state("version", "1.0.0")
  .derive(({ jwt, cookie: { auth } }) => ({
    verify: () => jwt.verify(auth.value),
  }))
  .get("/version", ({ store }) => store.version)
  .get("/profile", ({ verify }) => verify() ?? { error: "Unauthorized" });
```

---

## Generic Lambdas

Define event-driven functions in `src/functions/` for non-HTTP workloads. Triggers include SQS, EventBridge schedules, S3, SNS, and Kinesis.

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: "sqs",
  handler: async (event) => {
    for (const record of event.Records) {
      console.log("Processing:", JSON.parse(record.body));
    }
  },
});
```

### SQS Trigger

Process messages from a queue. Optionally auto-create the queue with configuration.

```typescript
export default defineLambda({
  trigger: {
    type: "sqs",
    batchSize: 10,
    visibilityTimeout: 60,
  },
  handler: async (event) => {
    for (const record of event.Records) {
      const body = JSON.parse(record.body);
      console.log("Message:", body);
    }
  },
});
```

### Schedule Trigger

Run code on a recurring schedule using EventBridge. Durations support formats like "1 day", "6 hours", "30 minutes", or shorthand "1d", "6h", "30m".

```typescript
export default defineLambda({
  trigger: {
    type: "schedule",
    every: "1 day",
  },
  handler: async () => {
    console.log("Running daily cleanup...");
  },
});
```

### S3 Trigger

Respond to object creation or deletion events with optional prefix/suffix filtering.

```typescript
export default defineLambda({
  trigger: {
    type: "s3",
    events: ["s3:ObjectCreated:*"],
    prefix: "uploads/",
    suffix: ".jpg",
  },
  handler: async (event) => {
    for (const record of event.Records) {
      console.log("Bucket:", record.s3.bucket.name);
      console.log("Key:", record.s3.object.key);
    }
  },
});
```

### SNS Trigger

Handle notifications with optional message filtering.

```typescript
export default defineLambda({
  trigger: {
    type: "sns",
    filterPolicy: { severity: ["high", "critical"] },
  },
  handler: async (event) => {
    for (const record of event.Records) {
      console.log("Message:", record.Sns.Message);
    }
  },
});
```

### Kinesis Trigger

Process data streams with configurable batch size and starting position.

```typescript
export default defineLambda({
  trigger: {
    type: "kinesis",
    batchSize: 100,
    startingPosition: "LATEST",
  },
  handler: async (event) => {
    for (const record of event.Records) {
      const data = Buffer.from(record.kinesis.data, "base64");
      console.log("Record:", data.toString());
    }
  },
});
```

---

## Configuration

Create `elysian.config.ts` to customize your project. The only required option is `name`, which prefixes all AWS resources.

```typescript
import { defineConfig } from "@actuallyjamez/elysian";

export default defineConfig({
  name: "my-api",
  outputDir: "dist",
  api: {
    dir: "src/api",
    openapi: { enabled: true, title: "My API" },
  },
  functions: { dir: "src/functions" },
  build: { minify: true, sourcemap: false },
  lambda: { runtime: "nodejs22.x", memorySize: 256, timeout: 30 },
  terraform: { outputDir: "terraform" },
});
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | - | **Required.** Resource name prefix |
| `outputDir` | `string` | `"dist"` | Build output directory |
| `api.dir` | `string` | `"src/api"` | API routes directory |
| `api.openapi.enabled` | `boolean` | `true` | Enable OpenAPI spec |
| `api.openapi.title` | `string` | config name | OpenAPI title |
| `api.openapi.version` | `string` | package.json version | OpenAPI version |
| `functions.dir` | `string` | `"src/functions"` | Functions directory |
| `build.minify` | `boolean` | varies | Minify output |
| `build.sourcemap` | `boolean` | varies | Generate sourcemaps |
| `build.external` | `string[]` | `["@aws-sdk/*"]` | Bundler externals |
| `lambda.runtime` | `string` | `"nodejs22.x"` | Lambda runtime |
| `lambda.memorySize` | `number` | `256` | Memory in MB |
| `lambda.timeout` | `number` | `30` | Timeout in seconds |
| `terraform.outputDir` | `string` | `"terraform"` | Terraform directory |

---

## CLI Commands

### Init

Initialize a new project with sensible defaults. Detects package manager from lockfiles and scaffolds all necessary files.

```bash
# Interactive wizard
bunx @actuallyjamez/elysian init

# Skip prompts with options
bunx @actuallyjamez/elysian init my-api --package-manager bun --install
```

### Dev

Start the development server with file watching and LocalStack integration. Changes rebuild automatically and sync to LocalStack for testing.

```bash
# Standard watch mode
bun run dev
bunx @actuallyjamez/elysian dev

# Faster (no zip packaging)
bunx @actuallyjamez/elysian dev --no-package

# Skip LocalStack
bunx @actuallyjamez/elysian dev --no-localstack
```

### Build

Bundle all lambdas for deployment. Outputs JavaScript bundles, zip packages, and Terraform configuration.

```bash
# Development build
bun run build
bunx @actuallyjamez/elysian build

# Production build (minified, no sourcemaps)
bunx @actuallyjamez/elysian build --prod
```

### Generate IAC

Regenerate Terraform files without rebuilding. Useful after changing configuration or when infrastructure diverges.

```bash
bunx @actuallyjamez/elysian generate-iac
```

---

## Project Structure

```
my-api/
├── elysian.config.ts         # Configuration
├── package.json              # Dependencies & scripts
├── tsconfig.json            # TypeScript config
├── .gitignore               # Git ignore patterns
├── src/
│   ├── api/                  # HTTP routes → Lambda + API Gateway
│   │   ├── users.ts          # → my-api-users
│   │   └── posts.ts          # → my-api-posts
│   └── functions/            # Event-driven functions
│       ├── process-queue.ts  # → my-api-process-queue (SQS)
│       └── daily-cleanup.ts  # → my-api-daily-cleanup (Schedule)
├── dist/                    # Build output
│   ├── my-api-users.js
│   ├── my-api-users.zip
│   ├── my-api-users.manifest.json
│   ├── __openapi__.js       # Swagger UI + OpenAPI spec
│   └── __openapi__.zip
└── terraform/
    ├── providers.tf          # AWS provider
    ├── variables.tf         # Terraform variables
    ├── main.tf             # Lambda, API Gateway, IAM
    ├── outputs.tf          # Endpoint URLs
    ├── api-routes.auto.tfvars  # Route→Lambda mapping
    └── functions.auto.tfvars   # Function triggers
```

---

## How It Works

1. **Discovery** - Scans `src/api/` and `src/functions/` for `.ts` files
2. **Bundling** - Packages each file into a standalone Lambda bundle
3. **Wrapping** - Injects Lambda handlers that bridge Elysia to API Gateway
4. **OpenAPI** - Aggregates all route schemas into a single spec endpoint
5. **Infrastructure** - Generates modular Terraform for AWS resources

The generated Terraform files append to existing configurations rather than overwriting them, so you can customize infrastructure without losing changes.

---

## Requirements

- [Bun](https://bun.sh/) v1.0+
- [Elysia](https://elysiajs.com/) v1.0+
- Node.js 18+ (Lambda runtime)
- AWS account with appropriate permissions

---

## License

MIT
