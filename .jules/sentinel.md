## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-05-21 - Command Injection in Archive Packaging & Extraction
**Vulnerability:** Invoking system utilities (`zip` and `unzip`) via `execAsync` with double-quoted shell string interpolation (`zip -j "${zipPath}" ${fileArgs}`) exposed the server to command injection if uploaded archive filepaths or metadata file arguments contained shell metacharacters.
**Learning:** Wrapping file paths in shell double quotes does not defend against characters like `$()` or backticks if an unexpected filename slips past or when handling uploaded zip paths.
**Prevention:** Always spawn archive CLI tools (`zip`, `unzip`) using `execFile`/`execFileAsync` with argument arrays instead of running through `/bin/sh`.
