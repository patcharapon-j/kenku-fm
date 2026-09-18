// Builds the Windows Squirrel installer without any code signing.
//
// This is the counterpart to index.js for builds that have no DigiCert
// Software Trust Manager credentials available (forks, manual releases).
// The produced installer is functional but unsigned, so Windows SmartScreen
// will warn users on first run.
//
// Usage: node ./publish/windows/make-unsigned.js <version>

import { createWindowsInstaller } from "electron-winstaller";
import path from "node:path";
import { exit } from "node:process";

async function createApp(version) {
  const __dirname = import.meta.dirname;
  const parent = path.resolve(__dirname, "..", "..");

  try {
    await createWindowsInstaller({
      appDirectory: path.join(parent, "out", `Kenku FM-win32-${process.arch}`),
      outputDirectory: path.join(parent, "out", "windows"),
      loadingGif: path.join(parent, "src", "assets", "loading.gif"),
      setupIcon: path.join(parent, "src", "assets", "setup.ico"),
      iconUrl: path.join(parent, "src", "assets", "setup.ico"),
      noMsi: true,
      exe: "kenku-fm.exe",
      name: `kenku-fm-win32-${process.arch}`,
      setupExe: `kenku-fm-win32-${process.arch}-${version}.exe`,
    });
  } catch (e) {
    console.log(`Error occured: ${e.message}`);
    exit(1);
  }
}

const appVersion = process.argv.slice(2)[0];

if (appVersion === undefined) {
  console.log("app version is undefined");
  exit(1);
}

createApp(appVersion);
