## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-09-26 - Command Injection in Title Card FFmpeg Generation
**Vulnerability:** User-supplied `title` and `subtitle` strings in `/api/generate-title-card` were escaped with `.replace(/'/g, "'\\\\''")` and formatted directly into a shell command line string executed via `execAsync(cmd)`. This allowed arbitrary shell command execution via subexpressions like `$(cmd)`.
**Learning:** String quote-escaping is unsafe when passing user input to shell invocations (`execAsync`), because subshell evaluations `$(...)` and backticks still execute within double quotes or filter strings parsed by the shell.
**Prevention:** Write user-controlled text strings to temporary files and reference them via `drawtext=textfile='...'` with `expansion=none`. Execute ffmpeg using `execFileAsync('ffmpeg', args)` with argument arrays to avoid invoking a system shell.
