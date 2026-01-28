---
"@actuallyjamez/elysian": minor
---

### Breaking Change: Rename apiName to name

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
