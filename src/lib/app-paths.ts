import fs from 'fs';
import path from 'path';

const DEFAULT_APP_NAME = 'etta-timekeeper';

export function getAppName(): string {
  return process.env.TIMEKEEPER_APP_NAME?.trim() || DEFAULT_APP_NAME;
}

export function getDataDir(): string {
  const configuredPath =
    process.env.TIMEKEEPER_DATA_DIR?.trim() ||
    process.env.ELECTRON_USER_DATA?.trim();

  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(process.cwd(), 'data');
}

export function ensureDataDir(): string {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getDataFilePath(fileName: string): string {
  return path.join(ensureDataDir(), fileName);
}

export function getLogsDir(): string {
  const configuredPath = process.env.TIMEKEEPER_LOG_DIR?.trim();
  return configuredPath ? path.resolve(configuredPath) : path.join(getDataDir(), 'logs');
}

export function ensureLogsDir(): string {
  const logsDir = getLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

export function getLogPath(fileName = 'server.log'): string {
  return path.join(ensureLogsDir(), fileName);
}

export function resolveDataPath(configuredPath: string | undefined, fallbackFileName: string): string {
  if (configuredPath?.trim()) {
    const resolved = path.resolve(configuredPath.trim());
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }

  return getDataFilePath(fallbackFileName);
}
