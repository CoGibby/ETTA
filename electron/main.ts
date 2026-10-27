import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { autoUpdater } from "electron-updater";

const isDevelopment = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let applicationOrigin: string | null = null;
let dataDirectory: string | null = null;

const ENTRA_DEFAULTS: Record<string, string> = {
  AZURE_CLIENT_ID: "b13c664e-d672-412b-bb7a-4eb9e53e059c",
  AZURE_TENANT_ID: "8a198873-4fec-4e76-8182-ca479edbbd60",
  AZURE_SCOPES: "Mail.Read Calendars.Read User.Read offline_access",
  OUTLOOK_BACKEND: "graph",
};

for (const [key, value] of Object.entries(ENTRA_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// In-place updates via electron-updater. Internal prerelease builds (version
// contains "-ppmo") never auto-update; the feed goes live at public release.
const updaterEnabled = !isDevelopment && !app.getVersion().includes("-ppmo");
if (updaterEnabled) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => appendServerLog(`\nUpdate error: ${String(error)}\n`));
  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update-downloaded");
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`ETTA did not start in time: ${String(lastError ?? "unknown error")}`);
}

function appendServerLog(chunk: unknown): void {
  const logsDirectory = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDirectory, { recursive: true });
  fs.appendFileSync(path.join(logsDirectory, "server.log"), String(chunk));
}

async function startPackagedServer(): Promise<string> {
  const port = await reservePort();
  const nextDirectory = path.join(process.resourcesPath, "next");
  const serverPath = path.join(nextDirectory, "server.js");
  dataDirectory = path.join(app.getPath("userData"), "data");
  const scriptsDirectory = path.join(process.resourcesPath, "outlook-scripts");

  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Packaged Next.js server was not found at ${serverPath}`);
  }

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: nextDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      ETTA_DATA_DIR: dataDirectory,
      TIMEKEEPER_DATA_DIR: dataDirectory,
      ELECTRON_USER_DATA: dataDirectory,
      DB_PATH: path.join(dataDirectory, "timekeeper.db"),
      MSAL_CACHE_PATH: path.join(dataDirectory, "msal-cache.json"),
      MSAL_FLOW_PATH: path.join(dataDirectory, "outlook-device-flow.json"),
      TIMEKEEPER_SCRIPTS_DIR: scriptsDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", appendServerLog);
  serverProcess.stderr?.on("data", appendServerLog);
  serverProcess.once("exit", (code, signal) => {
    appendServerLog(`\nServer exited with code=${String(code)} signal=${String(signal)}\n`);
    serverProcess = null;
  });

  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(origin);
  return origin;
}

function createWindow(origin: string): void {
  applicationOrigin = origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: "ETTA Time Tracker",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isOutlookAuthStartUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        appendServerLog(`\nOpening Outlook sign-in in the default browser failed: ${String(error)}\n`);
      });
      return { action: "deny" };
    }
    if (applicationOrigin && url.startsWith(applicationOrigin)) return { action: "allow" };
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });

  void mainWindow.loadURL(origin);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopServer(): void {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  serverProcess = null;
}

function isOutlookSignInInProgress(): boolean {
  if (!dataDirectory) return false;
  return fs.existsSync(path.join(dataDirectory, "outlook_pkce.json"));
}

function isOutlookAuthStartUrl(rawUrl: string): boolean {
  if (!applicationOrigin) return false;
  try {
    const url = new URL(rawUrl);
    return url.origin === new URL(applicationOrigin).origin && url.pathname === "/api/outlook/auth/start";
  } catch {
    return false;
  }
}

function isAllowedNavigation(rawUrl: string): boolean {
  if (isDevelopment) return true;
  if (!applicationOrigin) return false;
  if (rawUrl.startsWith(applicationOrigin)) return true;
  return isOutlookSignInInProgress() && rawUrl.startsWith("https://");
}

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const origin = isDevelopment
      ? process.env.ELECTRON_START_URL || "http://127.0.0.1:3000"
      : await startPackagedServer();
    createWindow(origin);

    if (updaterEnabled) {
      void autoUpdater
        .checkForUpdatesAndNotify()
        .catch(() => { /* update check is best-effort */ });
    }
  }).catch((error) => {
    appendServerLog(`\nDesktop startup failed: ${String(error)}\n`);
    app.quit();
  });
}

app.on("before-quit", stopServer);
app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
