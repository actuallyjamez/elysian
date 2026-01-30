# elysian

> Automatic Lambda bundler for [Elysia](https://elysiajs.com/) with AWS API Gateway and Terraform integration.

Elysian simplifies deploying Elysia.js applications to AWS Lambda by automatically generating handlers, bundling code, and creating infrastructure. Focus on writing your application logic while elysian handles the deployment complexity.

## Features

- **API Routes** - Define HTTP endpoints in `src/api/` using `defineRoutes()`
- **Generic Lambdas** - Create event-driven functions in `src/functions/` using `defineLambda()`
- **Type-safe configuration** - Full TypeScript support with `defineConfig()`
- **Smart Terraform integration** - Generates modular infrastructure without overwriting your config
- **Watch mode** - Fast rebuilds during development
- **Multi-package manager support** - Automatically detects bun/npm/pnpm/yarn
- **OpenAPI auto-aggregation** - Single Swagger UI endpoint for all routes

---

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

---

## Quick Start

### 1. Initialize your project

```bash
elysian init
```

The wizard will:
- Detect your package manager from lockfiles
- Create all necessary project files
- Install dependencies (for fresh projects)

### 2. Define API routes

Create files in `src/api/` using `defineRoutes()`:

```typescript
// src/api/users.ts
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  .get("/", () => "Hello, Elysian!")
  .get("/users", () => db.users.findMany(), {
    response: t.Array(t.Object({ id: t.String(), name: t.String() })),
    detail: { summary: "List users", tags: ["Users"] },
  })
  .get("/users/:id", ({ params }) => db.users.findUnique(params.id), {
    params: t.Object({ id: t.String() }),
    detail: { summary: "Get user by ID", tags: ["Users"] },
  });
```

### 3. Define Lambda functions

Create files in `src/functions/` using `defineLambda()`:

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

### 4. Build and deploy

```bash
# Build all lambdas
elysian build

# Deploy infrastructure
cd terraform
terraform init
terraform apply
```

---

## API Routes (`defineRoutes`)

Define HTTP API endpoints in `src/api/` directory. Each file becomes a separate Lambda function with its own API Gateway endpoint.

Since `defineRoutes()` returns an Elysia instance, you have full access to the entire Elysia ecosystem including plugins, state, decorators, hooks, and more.

### Basic Usage

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  .get("/hello", () => "Hello World!")
  .post("/users", ({ body }) => db.createUser(body), {
    body: t.Object({ name: t.String(), email: t.String() }),
  });
```

### Route Methods

All standard HTTP methods are supported:

```typescript
export default defineRoutes()
  .get("/items", () => db.items.findMany())
  .post("/items", ({ body }) => db.items.create(body))
  .put("/items/:id", ({ params, body }) => db.items.update(params.id, body))
  .patch("/items/:id", ({ params, body }) => db.items.update(params.id, body))
  .delete("/items/:id", ({ params }) => db.items.delete(params.id))
```

### Request Types

Define typed request parameters using Elysia's `t` utility:

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  // Path parameters
  .get("/users/:id", ({ params }) => {
    return db.users.findUnique(params.id);
  }, {
    params: t.Object({ id: t.String() }),
  })

  // Query parameters
  .get("/search", ({ query }) => {
    return db.items.findMany({ where: { name: { contains: query.q } } });
  }, {
    query: t.Object({ q: t.String() }),
  })

  // Request body
  .post("/users", ({ body }) => {
    return db.users.create(body);
  }, {
    body: t.Object({
      name: t.String(),
      email: t.String(),
      age: t.Optional(t.Number()),
    }),
  })

  // Headers
  .get("/secure", ({ headers }) => {
    return { token: headers.authorization };
  }, {
    headers: t.Object({
      authorization: t.String(),
    }),
  });
```

### Response Types

Define response schemas for OpenAPI documentation:

```typescript
export default defineRoutes()
  .get("/users", () => {
    return db.users.findMany();
  }, {
    response: t.Array(t.Object({
      id: t.String(),
      name: t.String(),
      email: t.String(),
    })),
    detail: {
      summary: "List all users",
      description: "Returns an array of user objects",
      tags: ["Users"],
    },
  });
```

### OpenAPI Metadata

Add OpenAPI documentation to routes:

```typescript
export default defineRoutes()
  .get("/users", () => db.users.findMany(), {
    detail: {
      summary: "List users",
      description: "Retrieve a list of all users in the system",
      tags: ["Users"],
      operationId: "listUsers",
      deprecated: false,
    },
  })
  .get("/users/:id", ({ params }) => db.users.findUnique(params.id), {
    params: t.Object({ id: t.String() }),
    detail: {
      summary: "Get user",
      tags: ["Users"],
    },
  });
```

### Accessing the Elysia App

Since `defineRoutes()` returns an Elysia instance, you can use all Elysia features directly:

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";
import { cors } from "@elysiajs/cors";
import { jwt } from "@elysiajs/jwt";
import { cookie } from "@elysiajs/cookie";

export default defineRoutes()
  .use(cors())
  .use(jwt({ secret: "your-secret" }))
  .use(cookie())
  .derive(({ jwt, cookie: { auth } }) => {
    return {
      verify: () => jwt.verify(auth.value),
    };
  })
  .get("/profile", ({ verify }) => {
    const user = verify();
    return user ?? { error: "Unauthorized" };
  })
  .post("/login", ({ cookie, jwt, body }) => {
    const user = db.users.findUnique(body.email);
    if (!user) return { error: "Invalid credentials" };
    
    const token = jwt.sign({ id: user.id, email: user.email });
    cookie.auth.set({ value: token, httpOnly: true });
    return { success: true };
  });
```

You can use any Elysia plugins, including:
- [@elysiajs/cors](https://elysiajs.com/plugins/cors.html) - CORS headers
- [@elysiajs/jwt](https://elysiajs.com/plugins/jwt.html) - JWT authentication
- [@elysiajs/cookie](https://elysiajs.com/plugins/cookie.html) - Cookie handling
- [@elysiajs/html](https://elysiajs.com/plugins/html.html) - HTML responses
- [@elysiajs/static](https://elysiajs.com/plugins/static.html) - Static file serving
- And any other Elysia-compatible plugins

### Decorators and State

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  .decorate("db", database)
  .state("version", "1.0.0")
  .get("/version", ({ store }) => store.version)
  .get("/db-health", ({ db }) => db.ping());
```

### Error Handling

```typescript
import { defineRoutes, t } from "@actuallyjamez/elysian";

export default defineRoutes()
  .error(({ error }) => {
    return new Response(error.toString(), { status: 500 });
  })
  .get("/users/:id", ({ params }) => {
    const user = db.users.findUnique(params.id);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  });
```

---

## Generic Lambdas (`defineLambda`)

Define event-driven Lambda functions in `src/functions/` directory. These are separate from API routes and can be triggered by various AWS events.

### Supported Triggers

#### SQS (Simple Queue Service)

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: "sqs",
  handler: async (event) => {
    for (const record of event.Records) {
      const body = JSON.parse(record.body);
      console.log("Processing message:", body);
    }
  },
});
```

With auto-created queue configuration:

```typescript
export default defineLambda({
  trigger: {
    type: "sqs",
    batchSize: 10,
    visibilityTimeout: 60,
    messageRetentionSeconds: 86400,
    fifo: true,
    contentBasedDeduplication: true,
  },
  handler: async (event) => {
    for (const record of event.Records) {
      console.log("Processing:", record.body);
    }
  },
});
```

#### Schedule (EventBridge)

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: {
    type: "schedule",
    every: "1 day",  // "6 hours", "30 minutes", "1h", "30m"
  },
  handler: async (event) => {
    console.log("Running daily cleanup...");
  },
});
```

#### S3 (Simple Storage Service)

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: {
    type: "s3",
    events: ["s3:ObjectCreated:*", "s3:ObjectDeleted:*"],
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

#### SNS (Simple Notification Service)

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: {
    type: "sns",
    filterPolicy: {
      severity: ["high", "critical"],
    },
  },
  handler: async (event) => {
    for (const record of event.Records) {
      const message = JSON.parse(record.Sns.Message);
      console.log("Alert:", message);
    }
  },
});
```

#### Kinesis

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  trigger: {
    type: "kinesis",
    batchSize: 100,
    startingPosition: "LATEST",
    shardCount: 2,
    retentionPeriodHours: 24,
  },
  handler: async (event) => {
    for (const record of event.Records) {
      const data = Buffer.from(record.kinesis.data, "base64");
      console.log("Record:", data.toString());
    }
  },
});
```

#### Manual/No Trigger

```typescript
import { defineLambda } from "@actuallyjamez/elysian";

export default defineLambda({
  handler: async (event) => {
    return { success: true, timestamp: Date.now() };
  },
});
```

### Event Types

Each trigger type provides the correct event type:

| Trigger | Event Type |
|---------|------------|
| `sqs` | `SQSEvent` |
| `schedule` | `ScheduledEvent` |
| `s3` | `S3Event` |
| `sns` | `SNSEvent` |
| `kinesis` | `KinesisStreamEvent` |

---

## Configuration

Create `elysian.config.ts` in your project root:

```typescript
import { defineConfig } from "@actuallyjamez/elysian";

export default defineConfig({
  name: "my-api",
  outputDir: "dist",
  api: {
    dir: "src/api",
    openapi: {
      enabled: true,
      title: "My API",
      version: "1.0.0",
      description: "API description",
    },
  },
  functions: {
    dir: "src/functions",
  },
  build: {
    minify: true,
    sourcemap: false,
    external: ["@aws-sdk/*"],
  },
  lambda: {
    runtime: "nodejs22.x",
    memorySize: 256,
    timeout: 30,
  },
  terraform: {
    outputDir: "terraform",
    tfvarsFilename: "api-routes.auto.tfvars",
    functionsTfvarsFilename: "functions.auto.tfvars",
  },
});
```

### Configuration Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | - | **Required.** Used for resource naming |
| `outputDir` | `string` | `"dist"` | Build output directory |
| `api.dir` | `string` | `"src/api"` | API routes directory |
| `api.openapi.enabled` | `boolean` | `true` | Enable OpenAPI aggregation |
| `api.openapi.title` | `string` | config name | OpenAPI spec title |
| `api.openapi.version` | `string` | package.json version | OpenAPI spec version |
| `api.openapi.description` | `string` | `""` | OpenAPI spec description |
| `functions.dir` | `string` | `"src/functions"` | Functions directory |
| `build.minify` | `boolean` | `true` in prod | Minify output |
| `build.sourcemap` | `boolean` | `true` in dev | Generate sourcemaps |
| `build.external` | `string[]` | `["@aws-sdk/*"]` | Packages to exclude from bundle |
| `lambda.runtime` | `string` | `"nodejs22.x"` | Lambda runtime |
| `lambda.memorySize` | `number` | `256` | Memory in MB |
| `lambda.timeout` | `number` | `30` | Timeout in seconds |
| `terraform.outputDir` | `string` | `"terraform"` | Terraform output directory |

---

## CLI Commands

### `elysian init`

Initialize a new or existing elysian project.

```bash
# Interactive wizard
elysian init

# Initialize in current directory
elysian init .

# Initialize in subdirectory
elysian init my-api

# Force overwrite existing files
elysian init --force
```

**Creates for fresh projects:**
- `package.json` - With build scripts
- `tsconfig.json` - TypeScript configuration
- `.gitignore` - Ignores node_modules, dist, terraform state
- `elysian.config.ts` - Elysian configuration
- `src/api/hello.ts` - Example API route
- `src/functions/process-queue.ts` - Example function
- `terraform/` - AWS provider, variables, main, outputs

**For existing projects:**
- Detects package manager from lockfiles
- Creates `elysian.config.ts` (won't overwrite)
- Adds example files only if directories are empty
- Appends to existing Terraform files (won't overwrite)

### `elysian build`

Build all lambdas for deployment.

```bash
# Development build (with sourcemaps)
elysian build

# Production build (minified, no sourcemaps)
elysian build --prod
```

**Output:**
- `dist/*.js` - Bundled lambda code
- `dist/*.zip` - Lambda deployment packages
- `dist/manifest.json` - Route manifest
- `terraform/api-routes.auto.tfvars` - API route configuration
- `terraform/functions.auto.tfvars` - Function configuration

### `elysian dev`

Watch mode for development with LocalStack integration.

```bash
# Watch with packaging
elysian dev

# Watch without zip creation (faster)
elysian dev --no-package

# Skip LocalStack health check
elysian dev --no-localstack
```

### `elysian generate-iac`

Regenerate Terraform files without rebuilding lambdas.

```bash
elysian generate-iac
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
│   ├── api/                  # HTTP API routes (src/api/)
│   │   ├── users.ts          # → my-api-users Lambda
│   │   └── posts.ts          # → my-api-posts Lambda
│   └── functions/            # Generic Lambda functions (src/functions/)
│       ├── process-queue.ts  # → SQS Lambda
│       └── daily-cleanup.ts  # → Scheduled Lambda
├── dist/                    # Build output
│   ├── my-api-users.js
│   ├── my-api-users.zip
│   ├── my-api-posts.js
│   ├── my-api-posts.zip
│   ├── my-api-process-queue.js
│   ├── my-api-process-queue.zip
│   ├── __openapi__.js       # Auto-generated OpenAPI
│   ├── __openapi__.zip
│   └── manifest.json
└── terraform/
    ├── providers.tf          # AWS provider
    ├── variables.tf         # Terraform variables
    ├── main.tf             # Lambda & API Gateway resources
    ├── outputs.tf          # API endpoint URL
    ├── api-routes.auto.tfvars  # Auto-generated API routes
    └── functions.auto.tfvars   # Auto-generated functions
```

---

## How It Works

### 1. Route Discovery

The bundler scans `src/api/` for `.ts` files. Each file becomes a separate Lambda function with its own API Gateway endpoint.

```
src/api/
├── users.ts    → users.zip → AWS Lambda (my-api-users)
├── posts.ts    → posts.zip → AWS Lambda (my-api-posts)
└── auth.ts     → auth.zip  → AWS Lambda (my-api-auth)
```

### 2. Function Discovery

The bundler scans `src/functions/` for `.ts` files. Each file becomes a separate Lambda triggered by the specified event source.

```
src/functions/
├── process-queue.ts  → SQS Lambda (my-api-process-queue)
├── daily-cleanup.ts  → Scheduled Lambda (my-api-daily-cleanup)
```

### 3. Handler Injection

When you export a `defineRoutes()` result as default:

```typescript
// src/api/users.ts
export default defineRoutes().get("/users", () => db.getUsers());
```

The bundler automatically wraps it with a Lambda handler:

```typescript
import { createHandler } from "@actuallyjamez/elysian/runtime";

const app = defineRoutes().get("/users", () => db.getUsers());
export const handler = createHandler(app);
```

### 4. OpenAPI Aggregation

An `__openapi__` lambda is automatically generated that imports all routes and exposes:
- `GET /` - Swagger UI
- `GET /openapi/json` - OpenAPI JSON spec

### 5. Terraform Generation

Terraform files are generated with smart merging:
- `providers.tf` - AWS provider with version `~> 6.0`
- `variables.tf` - All variables (region, routes, functions)
- `main.tf` - API Gateway, Lambda, IAM resources
- `outputs.tf` - API endpoint URL
- `api-routes.auto.tfvars` - Route-to-Lambda mappings
- `functions.auto.tfvars` - Function trigger configurations

---

## Requirements

- [Bun](https://bun.sh/) runtime v1.0+
- [Elysia](https://elysiajs.com/) v1.0+
- Node.js 18+ (for Lambda runtime)
- AWS account with appropriate permissions

---

## License

MIT
