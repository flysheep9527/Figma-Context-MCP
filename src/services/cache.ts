import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import type { OutputFormat } from "~/utils/serialize.js";
import { stableStringify } from "~/utils/common.js";
import type { GetFigmaDataMetrics } from "~/services/get-figma-data-metrics.js";

const CACHE_SCHEMA_VERSION = 1;

export type FigmaDataCacheConfig = {
  cacheDir: string;
  ttlSeconds: number;
};

export type FigmaDataCacheKey = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
  outputFormat: OutputFormat;
};

export type CachedFigmaData = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

type CacheEnvelope<T> = {
  schemaVersion: number;
  createdAt: number;
  expiresAt: number;
  value: T;
};

export function defaultFigmaCacheDir(): string {
  return path.join(os.homedir(), ".figma-developer-mcp", "cache");
}

export function normalizeFigmaCacheTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || Number.isNaN(ttlSeconds)) return 24 * 60 * 60;
  return Math.max(0, Math.floor(ttlSeconds));
}

export function isFigmaCacheEnabled(config: FigmaDataCacheConfig | undefined): boolean {
  return Boolean(config && config.ttlSeconds > 0 && config.cacheDir);
}

export function buildFigmaDataCacheKey(key: FigmaDataCacheKey): string {
  return hashStableValue({
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...key,
    depth: key.depth ?? null,
    nodeId: key.nodeId ?? null,
  });
}

export async function readFigmaDataCache(
  config: FigmaDataCacheConfig,
  key: FigmaDataCacheKey,
): Promise<CachedFigmaData | undefined> {
  if (!isFigmaCacheEnabled(config)) return undefined;

  const cachePath = getCacheFilePath(config.cacheDir, buildFigmaDataCacheKey(key));
  try {
    const text = await fs.readFile(cachePath, "utf8");
    const entry = JSON.parse(text) as CacheEnvelope<CachedFigmaData>;
    if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
    if (Date.now() >= entry.expiresAt) return undefined;
    if (!entry.value?.formatted || !entry.value?.metrics) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

export async function writeFigmaDataCache(
  config: FigmaDataCacheConfig,
  key: FigmaDataCacheKey,
  value: CachedFigmaData,
): Promise<void> {
  if (!isFigmaCacheEnabled(config)) return;

  const cacheKey = buildFigmaDataCacheKey(key);
  const cachePath = getCacheFilePath(config.cacheDir, cacheKey);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const now = Date.now();
  const entry: CacheEnvelope<CachedFigmaData> = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    createdAt: now,
    expiresAt: now + config.ttlSeconds * 1000,
    value,
  };

  await fs.mkdir(config.cacheDir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(entry));
  await fs.rename(tmpPath, cachePath);
}

function getCacheFilePath(cacheDir: string, cacheKey: string): string {
  return path.join(cacheDir, `${cacheKey}.json`);
}

function hashStableValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
