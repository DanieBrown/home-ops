import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT } from "../shared/paths.mjs";

const dashboardDir = path.join(ROOT, "dashboard");
const isWindows = process.platform === "win32";
const exeSuffix = isWindows ? ".exe" : "";
const buildFlag = "--build";

function canRun(goBinary) {
  const result = spawnSync(goBinary, ["version"], {
    stdio: "ignore",
    shell: false,
  });

  return result.status === 0;
}

function resolveGoBinary() {
  const candidates = [];

  if (canRun("go")) {
    return "go";
  }

  for (const key of ["HOME_OPS_GO", "GO_EXE"]) {
    if (process.env[key]) {
      candidates.push(process.env[key]);
    }
  }

  if (process.env.GOROOT) {
    candidates.push(path.join(process.env.GOROOT, "bin", `go${exeSuffix}`));
  }

  if (isWindows) {
    candidates.push(
      "C:\\Program Files\\Go\\bin\\go.exe",
      "C:\\Program Files (x86)\\Go\\bin\\go.exe",
      path.join(process.env.USERPROFILE ?? "", "scoop", "apps", "go", "current", "bin", "go.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Go", "bin", "go.exe")
    );
  }

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) {
      continue;
    }

    if (canRun(candidate)) {
      return candidate;
    }
  }

  return null;
}

const rawArgs = process.argv.slice(2);
const shouldBuild = rawArgs.includes(buildFlag);
const forwardArgs = rawArgs.filter((arg) => arg !== buildFlag);
const goBinary = resolveGoBinary();

if (!goBinary) {
  console.error("Go was not found. Install Go 1.21+, add it to PATH, or set HOME_OPS_GO to the full path of go.exe.");
  process.exit(1);
}

const commandArgs = shouldBuild
  ? ["build", "-o", isWindows ? "home-ops-dashboard.exe" : "home-ops-dashboard", "."]
  : ["run", ".", "--path", "..", ...forwardArgs];

const child = spawn(goBinary, commandArgs, {
  cwd: dashboardDir,
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start the dashboard: ${error.message}`);
  process.exit(1);
});