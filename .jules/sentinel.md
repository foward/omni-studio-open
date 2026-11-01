## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-11-01 - OS Command Injection via Multer File Extensions & Subprocess Invocations
**Vulnerability:** File extensions extracted via `path.extname(file.originalname)` without sanitization and passed into shell command strings (`execAsync`) allowed command injection via crafted filenames.
**Learning:** `path.extname` preserves any trailing characters after a dot (such as shell metacharacters `;&|`).
**Prevention:** Sanitize extensions (`replace(/[^a-zA-Z0-9_.-]/g, '')`) and replace `execAsync` shell invocations with `execFileAsync` using parameter arrays.
