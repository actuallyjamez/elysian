# @actuallyjamez/elysian

## 0.9.0

### Minor Changes

- [`016149b`](https://github.com/actuallyjamez/elysian/commit/016149bcfabf6cf09f06701e6fbf9cb41dff30a7) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - fix live mode

## 0.8.0

### Minor Changes

- [`5a3ca84`](https://github.com/actuallyjamez/elysian/commit/5a3ca842f99f6a999d0c034861b138e59585e7c4) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - live mode

## 0.7.1

### Patch Changes

- [`22717d9`](https://github.com/actuallyjamez/elysian/commit/22717d9f7e7361033dd81fb147846e41bfcda04b) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - Fix build errors and improve error messages

  - Move **openapi**.ts generation to temp directory instead of user's src/lambdas
  - Add detailed build error output with line numbers and code context
  - Resolve hono and @elysiajs/openapi from elysian's node_modules (users don't need to install them)
  - Change starter template to use @types/node instead of bun-types

## 0.7.0

### Minor Changes

- [`40db40c`](https://github.com/actuallyjamez/elysian/commit/40db40c89fe9993d40e15e3979e3b30b352056a5) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - fix deploy failed in dev when lambdas are updated

## 0.6.0

### Minor Changes

- [`8f0108c`](https://github.com/actuallyjamez/elysian/commit/8f0108c0778a293a6bb16490ba23b504df3c2e22) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - improved dev command

## 0.5.1

### Patch Changes

- [`f4f9f03`](https://github.com/actuallyjamez/elysian/commit/f4f9f03e4a4a5197089266b79524d87faa0f1d9c) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - fix manifest generation

- [`77acc02`](https://github.com/actuallyjamez/elysian/commit/77acc025ad309a4cafc69450611021fb887c4da9) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - remove extra new line on init

## 0.5.0

### Minor Changes

- [`c76ff19`](https://github.com/actuallyjamez/elysian/commit/c76ff192ab6620e6ea2b6991efb6674544c49d54) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - ### Breaking Change: Rename apiName to name

  Users must rename `apiName` to `name` in their `elysian.config.ts`:

  ```typescript
  // Before
  export default defineConfig({
    apiName: "my-api",
  });

  // After
  export default defineConfig({
    name: "my-api",
  });
  ```

  ### Smart defaults for OpenAPI

  - `openapi.title` now defaults to `name` if not provided
  - `openapi.version` now reads from `package.json` if not provided
  - Silent fallback to '1.0.0' if package.json cannot be read

  ### Simplified init template

  - `elysian init` now generates minimal config with only `name` field
  - OpenAPI fields no longer included in generated config

  ### Updated everywhere

  - All function signatures updated
  - All references renamed (52 occurrences across 10 files)
  - Wizard flows updated to use `name` instead of `apiName`

### Patch Changes

- [`64383e0`](https://github.com/actuallyjamez/elysian/commit/64383e0d41e0f847330e8a9266429928003d8519) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - dont inclue name in answers

## 0.4.0

### Minor Changes

- [`618792a`](https://github.com/actuallyjamez/elysian/commit/618792a3de5c201664f0dc5155a89553eed94b1b) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - ### Simplified init scaffolding

  - Minimal `defineConfig` - only requires `apiName` and `openapi` title/version
  - Removed verbose comments from generated files
  - Cleaner example lambda without redundant JSDoc

  ### Updated defaults

  - Default Lambda runtime updated to `nodejs22.x`
  - Terraform AWS provider updated to `~> 6.0`
  - Lambda function names now use the bundle name directly (already prefixed with apiName)

- [`b8d9494`](https://github.com/actuallyjamez/elysian/commit/b8d94942dc9cfe8a306fcce61c671c69145c53e7) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - ### Interactive init wizard

  Completely redesigned the `elysian init` command as an interactive wizard:

  **Fresh projects (empty directory):**

  - Prompts for API name and package manager
  - Creates package.json, tsconfig.json, .gitignore
  - Auto-installs dependencies

  **Existing projects:**

  - Detects package manager from lockfiles
  - Uses package.json name as default API name
  - Only creates example lambda if no lambdas exist

  **Smart Terraform handling:**

  - Splits into 4 files: providers.tf, variables.tf, main.tf, outputs.tf
  - Smart append: adds missing blocks to existing files without overwriting
  - Preserves existing configuration

  **New features:**

  - Package manager detection (bun/npm/pnpm/yarn)
  - Automatic dependency installation
  - Better error handling and cancellation support

## 0.3.0

### Minor Changes

- [`8073513`](https://github.com/actuallyjamez/elysian/commit/8073513a5a6f07d19600c287d247f0c1d1ff0329) Thanks [@actuallyjamez](https://github.com/actuallyjamez)! - ### Features

  - API name prefix for bundles - Lambda bundles are now prefixed with the `apiName` from config (e.g., `cms-api-hello.zip`) to avoid naming conflicts
  - Improved build output - Cleaner CLI output with checkmarks, routes grouped by lambda, method coloring, and compact summary
  - Dynamic version display - Version now reads from package.json

  ### Changes

  - Package renamed to `@elysian/elysian` and published to npm
  - Added changesets for release management

### Patch Changes

- [`143cb2d`](https://github.com/actuallyjamez/elysian/commit/143cb2d63a7880711ebaa49f5de4b4867f97a425) Thanks [@actuallyjamez](https://github.com/actuallyjamez)! - actions release
