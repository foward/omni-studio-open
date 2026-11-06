## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-05-21 - Command Injection via Unsanitized Multer Upload Extension and Shell Interpolation
**Vulnerability:** Multer storage filename extracted file extensions via `path.extname(file.originalname)` without sanitization and saved files whose paths were later interpolated into shell command strings (`execAsync`) in `/api/upload-audio` and `/api/project/import`.
**Learning:** When uploads retain raw extensions, filenames can introduce shell metacharacters into disk paths that escape quotes in shell strings.
**Prevention:** Sanitize extensions in Multer `filename` callbacks using a strict regex whitelist, and invoke CLI utilities (`ffprobe`, `unzip`, etc.) using `execFileAsync` with argument arrays rather than shell interpolation.
