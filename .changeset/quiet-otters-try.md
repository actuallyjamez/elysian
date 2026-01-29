---
"@actuallyjamez/elysian": patch
---

Fix dev mode issues and improve init command:

- Fix openapi lambda not being subscribed to AppSync, causing `/openapi` endpoint to hang
- Fix terraform file watcher triggering on `localstack_providers_override.tf` temp file
- Fix init command to update existing package.json with missing name, version, and scripts fields
