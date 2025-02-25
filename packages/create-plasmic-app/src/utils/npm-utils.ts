/*eslint
@typescript-eslint/no-var-requires: 0,
*/
import * as execa from "execa";
import findupSync from "findup-sync";
import updateNotifier from "update-notifier";

/**
 * Call this to check if there's an update available
 * and display to the user
 * @returns version
 */
export function updateNotify(): string {
  const pkg = require("../../package.json");
  const notifier = updateNotifier({
    pkg,
    updateCheckInterval: 1000 * 60 * 60, // Check once an hour
  });
  notifier.notify();
  return pkg.version;
}

/**
 * Run a command on the shell synchronously
 * @param cmd
 * @param workingDir
 * @returns boolean - true if success, false if fail
 */
export async function spawn(
  cmd: string,
  workingDir?: string
): Promise<boolean> {
  console.log(cmd);
  const cp = await execa.command(cmd, {
    shell: true,
    stdio: "inherit",
    cwd: workingDir,
  });
  return cp.exitCode === 0;
}

/**
 * Install a package using either `npm` or `yarn`
 * @param pkg - package name
 * @param opts
 * @returns
 */
export async function installUpgrade(
  pkg: string,
  opts: { global?: boolean; dev?: boolean; workingDir?: string } = {}
): Promise<boolean> {
  const cmd = installCommand(pkg, opts);
  const r = await spawn(cmd, opts.workingDir);
  if (r) {
    console.log(`Successfully added ${pkg} dependency.`);
    return true;
  } else {
    console.warn(
      `Cannot add ${pkg} to your project dependencies. Please add it manually.`
    );
    return false;
  }
}

/**
 * Generate the installation command string for an npm package
 * @param pkg
 * @param opts
 * @returns
 */
function installCommand(
  pkg: string,
  opts: { global?: boolean; dev?: boolean; workingDir?: string } = {}
): string {
  const mgr = detectPackageManager(opts.workingDir);
  if (mgr === "yarn") {
    if (opts.global) {
      return `yarn global add ${pkg}`;
    } else if (opts.dev) {
      return `yarn add --dev --ignore-scripts -W ${pkg}`;
    } else {
      return `yarn add --ignore-scripts -W ${pkg}`;
    }
  } else {
    if (opts.global) {
      return `npm install -g ${pkg}`;
    } else if (opts.dev) {
      return `npm install --save-dev --ignore-scripts ${pkg}`;
    } else {
      return `npm install --ignore-scripts ${pkg}`;
    }
  }
}

/**
 * Detect if you should use `npm` or `yarn`
 * @param dir
 * @returns
 */
export function detectPackageManager(dir?: string): "yarn" | "npm" {
  const yarnLock = findupSync("yarn.lock", { cwd: dir });
  if (yarnLock) {
    return "yarn";
  } else {
    return "npm";
  }
}
