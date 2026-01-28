---
"@actuallyjamez/elysian": minor
---

### Interactive init wizard

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
