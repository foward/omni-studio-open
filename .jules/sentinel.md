## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-05-21 - OS Command Injection in Audio Upload and Title Card Endpoints
**Vulnerability:** User-controlled strings (uploaded `originalname` extension and title card `title`/`subtitle` fields) interpolated into `execAsync` shell strings allowed command injection via double quotes and shell metacharacters.
**Learning:** `path.extname(file.originalname)` can contain arbitrary user input if the filename is crafted with quotes or shell operators; similarly, escaping single quotes in FFmpeg `-vf drawtext` is insufficient when the filter string is enclosed in double quotes in a shell command.
**Prevention:** Sanitize uploaded file extensions, use `execFileAsync` with argument arrays for CLI binaries like `ffprobe`, and pass text to FFmpeg filters via `textfile=` rather than inline shell command string interpolation.
