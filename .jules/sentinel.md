## 2026-05-20 - OS Command Injection via Audio Upload Filename Extension in Multer & ffprobe
**Vulnerability:** User-controlled file extension in `multer.diskStorage` was interpolated into an `execAsync` shell command (`ffprobe ... "${filePath}"`), allowing command injection via `file.originalname`.
**Learning:** `path.extname(file.originalname)` preserves metacharacters like double quotes and command separators (`"; touch /tmp/pwned; "`).
**Prevention:** Sanitize file extensions before saving to disk and use `execFileAsync` with argument arrays to execute binary CLI tools without spawning a shell interpreter.

## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.
