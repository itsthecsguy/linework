# When a command fails

`linework` in the guide means `npx -y @itsthecsguy/linework`. Run plain `linework` only if `command -v linework` (or `where linework` on Windows) finds it.

- **The download fails** (`ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `403`): there is probably no network, often because of a sandbox. Ask the user to let the command run with network access, or to run `npm install -g @itsthecsguy/linework` themselves.
- **"none was found":** no browser is installed. Run `linework install-browser`, or ask the user to install Chrome.
- **"found a Chromium-based browser but it could not start":** a sandbox is blocking it. Ask the user to run `npx -y @itsthecsguy/linework install-browser` once outside the sandbox (Linework's own Chromium starts inside Codex's sandbox), or to let the command run outside the sandbox. Don't tell them to install Chrome; they already have a browser.
- **An option or field is rejected that the guide says exists:** the guide may be newer or older than the installed package. Run `linework skill` to get the path of the guide that ships with the package, and read its SKILL.md. That copy always matches.
- **A build hangs or behaves oddly after an upgrade:** builds reuse a background process that keeps the browser running. `linework daemon stop` ends it, and `LINEWORK_NO_DAEMON=1` or `--no-daemon` runs without it.

Never fall back to writing SVG or draw.io XML by hand. Tell the user what failed and what they can do about it.
