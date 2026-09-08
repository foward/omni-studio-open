## 2026-05-20 - Safe macOS osascript execution and Multer file extension sanitization
**Vulnerability:** User-controlled string inputs in `notifyUser` and Multer file extensions were interpolated into shell execution strings (`exec` / `execAsync`), enabling OS command injection via single quote shell breakouts in `osascript` or metacharacters in file extensions.
**Learning:** String interpolation inside shell commands (`execAsync("osascript -e '...'")`) fails to neutralize single quotes or shell metacharacters even if double quotes or backslashes are stripped.
**Prevention:** Use `execFileAsync('osascript', ['-e', script])` to invoke subprocesses without a shell wrapper, stringify arguments safely with `JSON.stringify()`, and sanitize all file extensions with `sanitizeFilename()`.
