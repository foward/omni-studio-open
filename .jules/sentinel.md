## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-11-11 - OS Command Injection via Uploaded File Paths and Unsanitized Multer Extensions
**Vulnerability:** File paths containing user-provided extensions from `file.originalname` were interpolated directly into shell strings executed via `execAsync` (`ffprobe`, `zip`, `unzip`).
**Learning:** `path.extname(file.originalname)` can contain shell metacharacters (e.g. `;`, `` ` ``, `$()`), and wrapping file paths in double quotes inside shell template strings remains fragile against quoting quirks.
**Prevention:** Sanitize extensions extracted from `file.originalname` using a strict alphanumeric allowlist (`/[^a-zA-Z0-9_.-]/g`), and invoke external utilities (`ffprobe`, `zip`, `unzip`) using `execFileAsync` with argument arrays rather than `/bin/sh` string interpolation.
