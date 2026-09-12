## 2026-05-20 - macOS Notification osascript Command Injection
**Vulnerability:** Unsanitized string interpolation in shell execution (`osascript -e 'display notification "..."'`) allowed arbitrary command injection if notification title or message contained single quotes/shell metacharacters.
**Learning:** Naive replacement/sanitization of specific characters like double quotes or backslashes is insufficient when user inputs are embedded inside shell command strings passed to `exec`.
**Prevention:** Avoid string interpolation in shell commands (`exec`). Use `execFile` or `spawn` with an array of arguments, or pass data via `JSON.stringify()` in script arguments so inputs are parsed as data rather than shell commands.
