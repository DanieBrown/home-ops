# Shared Preflight -- Node, npm, and Dependencies

Run this preflight at the start of any mode that shells out to `node` or `npm run ...` scripts. It catches the most common "scripts fail silently because the toolchain is missing" class of failures.

## Step 1: Verify Node.js is on PATH

Run this command first:

```
node --version
```

- If the command fails or is not found, halt the mode immediately and present the user with install guidance:
  - Windows: `winget install OpenJS.NodeJS.LTS` (user may need to open a new terminal afterward for PATH to refresh).
  - macOS: `brew install node` or download the LTS installer from `https://nodejs.org/`.
  - Linux: use the distro package manager or `nvm install --lts`.
- If the version is below `18.0.0`, halt and ask the user to upgrade. Home-Ops targets Node 18+; the repo `.nvmrc` pins Node 20 as the preferred version.

## Step 2: Verify npm is on PATH

Run this command second:

```
npm --version
```

- npm ships with Node.js, but on some Windows installs it lands outside the shell PATH until the user reopens their terminal. If the command fails, halt the mode and tell the user to:
  1. Close and reopen the terminal (or run `refreshenv` in PowerShell if they have Chocolatey helpers loaded).
  2. Re-run the Node.js installer and make sure "Add to PATH" is checked.
  3. If they are using `nvm-windows`, run `nvm use lts` (or the version from `.nvmrc`).
- If the version is below `9.0.0`, halt and ask the user to upgrade.

## Step 3: Bootstrap project dependencies

For init/browser-session commands, run the checked-in bootstrap before launching the browser session:

```
npm run bootstrap
```

- This installs project dependencies with `npm install` when `node_modules/`, `playwright`, or `yaml` are missing.
- It installs Playwright Chromium with `npx playwright install chromium` when the browser binary is missing.
- Init/browser setup runs bootstrap with Python sidecar setup enabled. If Python 3.10+ is present, it installs the crawl4ai requirements and browser assets. On Windows, it can attempt Python 3.12 installation through `winget` when Python is missing.
- Do not silently skip this. The buyer profile and browser session flows depend on `playwright` and `yaml`; if they are missing, every downstream `npm run ...` in init or profile will fail.

## Step 4: Proceed with the rest of the mode

Only continue into the mode's main instructions once Node, npm, and bootstrap pass. If Node or npm is missing, halt and surface the install guidance because Home-Ops cannot self-install the runtime it is running on.
