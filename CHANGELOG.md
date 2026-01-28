# @actuallyjamez/elysian

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
