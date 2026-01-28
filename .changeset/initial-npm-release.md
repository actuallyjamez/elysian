---
"@actuallyjamez/elysian": minor
---

### Features
- API name prefix for bundles - Lambda bundles are now prefixed with the `apiName` from config (e.g., `cms-api-hello.zip`) to avoid naming conflicts
- Improved build output - Cleaner CLI output with checkmarks, routes grouped by lambda, method coloring, and compact summary
- Dynamic version display - Version now reads from package.json

### Changes
- Package renamed to `@elysian/elysian` and published to npm
- Added changesets for release management
