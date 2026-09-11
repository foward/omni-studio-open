## 2026-05-20 - OS Command Injection in macOS Desktop Notifications
**Vulnerability:** User-controlled title and message input passed to `osascript` via `exec` in `notifyUser` allowed shell command injection because single quotes were not stripped/escaped in shell string interpolation.
**Learning:** `exec` invokes `/bin/sh`, making inline string formatting vulnerable to shell syntax injection even when quotes are partially stripped.
**Prevention:** Use `execFile` or `execFileAsync` with array arguments to invoke binaries like `osascript` directly without spawning a shell interpreter.
