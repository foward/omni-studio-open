## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-11-07 - OS Command Injection via FFmpeg Drawtext Filter and Card Type
**Vulnerability:** In `/api/generate-title-card`, `title`, `subtitle`, and `type` from the request body were directly interpolated into a shell command executed by `execAsync`. Escaping only single quotes with `.replace(/'/g, "'\\\\''")` allowed shell breakout via double quotes (e.g. `"$(command)"`), and an unvalidated `type` allowed injection into the output filename.
**Learning:** Drawtext filters in FFmpeg take complex arguments where escaping quotes and colons in shell strings is error-prone. Writing user text to temporary files via `writeDrawtextFile` and passing `drawtext=textfile='...'` avoids shell escaping pitfalls entirely.
**Prevention:** Never interpolate user text or parameters directly into shell strings; use `textfile=` for FFmpeg text filters, strictly whitelist enum inputs like `type`, and ensure temp files are cleaned up in `finally` blocks.
