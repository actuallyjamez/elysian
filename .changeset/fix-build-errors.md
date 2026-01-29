---
"@actuallyjamez/elysian": patch
---

Fix build errors and improve error messages

- Move __openapi__.ts generation to temp directory instead of user's src/lambdas
- Add detailed build error output with line numbers and code context
- Resolve hono and @elysiajs/openapi from elysian's node_modules (users don't need to install them)
- Change starter template to use @types/node instead of bun-types
