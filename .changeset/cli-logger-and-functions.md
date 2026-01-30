---
"elysian": minor
---

Add generic Lambda functions support and improve CLI logging

**New Features:**
- Support for generic Lambda functions in `src/functions/` with triggers (schedule, SQS, EventBridge)
- New `defineLambda()` API for defining functions with typed triggers
- Automatic terraform deployment when trigger configuration changes
- Smart manifest diffing to detect infrastructure changes

**CLI Improvements:**
- New Signale-based logging system with timestamps and scoped output
- Better invocation logging showing function name, trigger type, and duration
- Console output from Lambda handlers displays inline with proper formatting
- Cleaner dev mode status screen with watching indicator

**Bug Fixes:**
- File watchers now create directories if missing, detecting new files properly
- Fixed duplicate console output from worker threads
