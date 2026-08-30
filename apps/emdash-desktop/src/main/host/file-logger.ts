import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redactAll, serializeLogValue, stringifyLogValue } from '@emdash/shared/logger';
import { createFileTransport, trimToLineBoundary } from '@emdash/shared/logger/node';
import { app } from 'electron';
import type pinoLib from 'pino';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DIAGNOSTIC_LOG_BYTES = 500 * 1024;
const RETAINED_LOG_FILES = 5;
const LOG_FILE_NAME = 'emdash.log';
const DIAGNOSTIC_ATTACHMENT_FILENAME = 'emdash-diagnostics.log';
const RENDERER_LOG_PAYLOAD_LIMIT = 64 * 1024;
const PROCESS_EXIT_FLUSH_TIMEOUT_MS = 1000;
const ORC_CRASH_REPORT_TIMEOUT_MS = 2500;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
let logFilePath: string | undefined;

export function initializeFileLogger() {
  const override = process.env.EMDASH_LOG_FILE?.trim();
  if (override) {
    logFilePath = resolve(override);
    return;
  }

  const electronApp = app as Electron.App | undefined;
  if (!electronApp?.setAppLogsPath) return;

  electronApp.setAppLogsPath(join(electronApp.getPath('userData'), 'logs'));
  logFilePath = join(electronApp.getPath('logs'), LOG_FILE_NAME);
}

export function getLogFilePath(): string | undefined {
  return logFilePath;
}

function resolveLogPath(): string | undefined {
  if (!logFilePath) initializeFileLogger();
  return logFilePath;
}

/**
 * Singleton file transport — shared between the pino destination and the
 * renderer log intake so there is exactly one serialized write queue.
 * The transport applies `redactAll` to every line by default; no explicit
 * redact wiring is needed here.
 */
const sharedTransport = createFileTransport({
  path: resolveLogPath,
  maxBytes: MAX_LOG_BYTES,
  retainedFiles: RETAINED_LOG_FILES,
});

/**
 * Returns a pino-compatible DestinationStream backed by the shared transport.
 * Called once at main-process logger construction.
 */
export function getLogFileDestination(): pinoLib.DestinationStream {
  return sharedTransport.asDestination();
}

export function flushLogWrites(): Promise<void> {
  return sharedTransport.flush();
}

export async function getDiagnosticLogAttachment() {
  const path = resolveLogPath();

  const fallback = {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: 'No application logs were available.',
  };

  if (!path) return fallback;

  const raw = await readFile(path, 'utf8').catch(() => '');
  const tail = trimToLineBoundary(raw, DIAGNOSTIC_LOG_BYTES);
  const redacted = redactAll(tail);

  return {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: redacted || fallback.content,
  };
}

export function registerProcessErrorLogging(logger: { error(...input: unknown[]): void }) {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    flushAndExit('uncaught-exception', error);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', reason);
    flushAndExit('unhandled-rejection', reason);
  });
}

function flushAndExit(kind: string, error: unknown) {
  const flush = Promise.race([
    Promise.allSettled([flushLogWrites(), reportEmdashCrash(kind, error)]),
    new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_FLUSH_TIMEOUT_MS)),
  ]);
  void flush.finally(() => process.exit(1));
}

export async function reportEmdashCrash(kind: string, error: unknown): Promise<void> {
  const diagnostic = await getDiagnosticLogAttachment();
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
  await fetch('http://127.0.0.1:8790/diagnostics/emdash-crash', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind,
      message: redactAll(message).slice(0, 16_000),
      log_tail: diagnostic.content,
      observed_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(ORC_CRASH_REPORT_TIMEOUT_MS),
  }).catch(() => undefined);
}

export function writeRendererLogEntry(entry: {
  level: LogLevel;
  source: 'renderer';
  input: unknown[];
}) {
  if (!isWithinPayloadLimit(entry)) return;
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: entry.level,
    source: entry.source,
    message: entry.input.map((v) => (typeof v === 'string' ? v : stringifyLogValue(v))).join(' '),
    data: entry.input.map(serializeLogValue),
  });

  sharedTransport.write(payload);
}

function isWithinPayloadLimit(payload: unknown): boolean {
  try {
    return JSON.stringify(payload).length <= RENDERER_LOG_PAYLOAD_LIMIT;
  } catch {
    return false;
  }
}

/** Exported for diagnostic attachment (used in the diagnostics controller). */
export function redactDiagnosticLog(value: string): string {
  return redactAll(value);
}
