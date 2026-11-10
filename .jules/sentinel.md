## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-05-21 - Shell Injection in Archive Operations and Multer Extension Handling
**Vulnerability:** Invoking `zip` and `unzip` through `execAsync` using interpolated strings exposed archive operations to shell metacharacters in paths, and `path.extname(file.originalname)` in multer storage was unvalidated.
**Learning:** Even when filenames are checked or partially sanitized, wrapping CLI tool executions in `/bin/sh` shell strings risks shell-injection edge cases and quoting bugs across platforms.
**Prevention:** Always spawn archive tools via `execFileAsync` using parameter arrays, and strip unsafe characters from original file extensions (`replace(/[^a-zA-Z0-9_.-]/g, '')`).
