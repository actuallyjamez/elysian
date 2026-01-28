---
"@actuallyjamez/elysian": minor
---

### Simplified init scaffolding

- Minimal `defineConfig` - only requires `apiName` and `openapi` title/version
- Removed verbose comments from generated files
- Cleaner example lambda without redundant JSDoc

### Updated defaults

- Default Lambda runtime updated to `nodejs22.x`
- Terraform AWS provider updated to `~> 6.0`
- Lambda function names now use the bundle name directly (already prefixed with apiName)
