## 2026-05-20 - OS Command Injection in macOS Notification Helpers
**Vulnerability:** User-controlled strings passed into `execAsync` with shell template literals (`osascript -e 'display notification "${safeMsg}"...'`) allowed command injection via single quotes.
**Learning:** Sanitizing double quotes and backslashes is insufficient when single-quoted string arguments are parsed by `/bin/sh`.
**Prevention:** Avoid shell invocation entirely by using `execFile`/`execFileAsync` with argument arrays, and safely escape AppleScript string literals with `JSON.stringify()`.

## 2026-05-21 - OS Command Injection via Shell Subprocesses in Project Zip/Unzip Operations
**Vulnerability:** Invoking archive utilities `zip` and `unzip` with `execAsync` using shell template literals (`zip -j "${zipPath}" ${fileArgs}` and `unzip -o -j "${zipPath}" -d "${outputsDir}"`) exposed execution to shell interpolation risks if file paths contained metacharacters.
**Learning:** Shell quoting with double quotes (`"${var}"`) is vulnerable to parameter expansion (`$`), command substitution (backticks), or path metacharacters if passed through `/bin/sh`.
**Prevention:** Always invoke archive and CLI binary tools using `execFileAsync` with dedicated argument arrays rather than shell string interpolation.
