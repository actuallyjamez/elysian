---
"@actuallyjamez/elysian": patch
---

Improve dev mode logging and UX

**Dev Mode Improvements:**
- Single-line status updates during startup (no more flickering/duplicate lines)
- Simplified rebuild output - just one line showing rebuild time
- Terraform progress shows resource names during apply (Creating, Updating, Destroying)
- API/OpenAPI endpoint URLs are now clickable hyperlinks (OSC 8)
- Added blank line after ready screen to separate from invocation logs

**Scheduled Function Logging:**
- Scheduled invocations now show interval (e.g., "scheduled every 1m")
- "scheduled" displayed in yellow, interval in grey for better visibility

**Performance:**
- Reduced LocalStack health check timeout from 2s to 500ms
- Removed unnecessary "Detecting LocalStack..." status message
- Removed separate "Loading workers..." step

**Bug Fixes:**
- Fixed variable hoisting issue with endpoint display flags
- Fixed missing colors on awaiting status line
