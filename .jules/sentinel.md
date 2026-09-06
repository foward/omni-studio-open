## 2026-09-06 - Command Injection via `osascript` in `server.js`
**Vulnerability:** User-controlled strings (`title`, `message`) in notification handlers (`notifyUser`, `sendDesktopNotification`) were interpolated directly into shell command strings passed to `execAsync` calling `osascript`.
**Learning:** Sanitizing quotes using regex replacement (`replace(/["\\]/g, '')`) was insufficient to prevent shell or AppleScript injection when executed via `exec` in a subshell.
**Prevention:** Avoid `exec` with shell string interpolation when running external CLI tools. Use `execFile` (`execFileAsync`) to pass arguments directly to the executable without invoking a shell, and safely escape strings inside AppleScript using `JSON.stringify()`.
