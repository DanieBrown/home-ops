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

## Step 3: Verify project dependencies are installed

Check whether `node_modules/` exists in the repo root. If it does not, run:

```
npm install
```

- Do not silently skip this. The buyer profile and browser session flows depend on `playwright` and `yaml`; if they are missing, every downstream `npm run ...` in init or profile will fail.
- After `npm install` completes, also verify the Playwright browsers are installed. If the install log mentions a missing Chromium, run `npx playwright install chromium`.

## Step 4: Proceed with the rest of the mode

Only continue into the mode's main instructions once all three checks pass. If any check failed and the user declined to fix it, halt and do not run any `node` or `npm run ...` commands.
