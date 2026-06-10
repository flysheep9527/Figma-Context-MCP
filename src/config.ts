import { config as loadEnv } from "dotenv";
import fs from "fs";
import os from "os";
import { resolve as resolvePath } from "path";
import type { FigmaAuthOptions } from "./services/figma.js";
import { resolveTelemetryEnabled } from "./telemetry/index.js";
import { VALID_OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from "./utils/serialize.js";
import { defaultFigmaCacheDir, normalizeFigmaCacheTtl } from "./services/cache.js";

/**
 * 将路径中开头的 `~` 展开为用户主目录。
 * 例如：`~/foo/bar` → `/Users/username/foo/bar`
 */
export function expandTilde(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath;
}

export type Source = "cli" | "env" | "default";

export interface Resolved<T> {
  value: T;
  source: Source;
}

export interface ServerFlags {
  figmaApiKey?: string;
  figmaApiKeys?: string;
  figmaApiKeysFile?: string;
  figmaOauthToken?: string;
  env?: string;
  port?: number;
  host?: string;
  json?: boolean;
  format?: string;
  skipImageDownloads?: boolean;
  imageDir?: string;
  cacheDir?: string;
  cacheTtlSeconds?: number;
  proxy?: string;
  stdio?: boolean;
  noTelemetry?: boolean;
}

export interface ServerConfig {
  auth: FigmaAuthOptions;
  port: number;
  host: string;
  proxy: string | undefined;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir: string;
  cacheDir: string;
  cacheTtlSeconds: number;
  isStdioMode: boolean;
  noTelemetry: boolean;
  configSources: Record<string, Source>;
}

/** Resolve a config value through the priority chain: CLI flag → env var → default. */
export function resolve<T>(flag: T | undefined, env: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) return { value: flag, source: "cli" };
  if (env !== undefined) return { value: env, source: "env" };
  return { value: fallback, source: "default" };
}

export function envStr(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function envInt(...names: string[]): number | undefined {
  for (const name of names) {
    const val = process.env[name];
    if (val) return parseInt(val, 10);
  }
  return undefined;
}

export function envBool(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === "true") return true;
  if (val === "false") return false;
  return undefined;
}

export function parseApiKeyList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function readApiKeyFile(filePath: string): string[] {
  const resolvedPath = resolvePath(expandTilde(filePath));
  try {
    return parseApiKeyList(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Failed to read FIGMA_API_KEYS_FILE '${resolvedPath}': ${errorMessage}`);
  }
}

function resolveApiKeyListSource(flags: {
  figmaApiKey?: string;
  figmaApiKeys?: string;
  figmaApiKeysFile?: string;
}): Resolved<string[]> {
  const cliKeys = parseApiKeyList(flags.figmaApiKeys);
  if (cliKeys.length > 0) return { value: cliKeys, source: "cli" };

  if (flags.figmaApiKeysFile) {
    const fileKeys = readApiKeyFile(flags.figmaApiKeysFile);
    if (fileKeys.length > 0) return { value: fileKeys, source: "cli" };
  }

  if (flags.figmaApiKey) {
    return { value: [flags.figmaApiKey], source: "cli" };
  }

  const envKeys = parseApiKeyList(envStr("FIGMA_API_KEYS"));
  if (envKeys.length > 0) return { value: envKeys, source: "env" };

  const envKeysFile = envStr("FIGMA_API_KEYS_FILE");
  if (envKeysFile) {
    const fileKeys = readApiKeyFile(envKeysFile);
    if (fileKeys.length > 0) return { value: fileKeys, source: "env" };
  }

  const singleKey = resolve(flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  if (singleKey.value) return { value: [singleKey.value], source: singleKey.source };

  return { value: [], source: "default" };
}

// Throws on invalid input so callers control how the failure surfaces — the
// server entry point exits the process, but the `fetch` CLI command needs to
// run its `finally` (telemetry shutdown) before exiting, which `process.exit`
// would bypass.
export function parseOutputFormat(
  value: string | undefined,
  source: string,
): OutputFormat | undefined {
  if (value === undefined) return undefined;
  if (isOutputFormat(value)) return value;
  throw new Error(
    `Invalid ${source} value '${value}'. Expected one of: ${VALID_OUTPUT_FORMATS.join(", ")}`,
  );
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

export function loadEnvFile(envPath?: string): string {
  const envFilePath = envPath
    ? resolvePath(expandTilde(envPath))
    : resolvePath(process.cwd(), ".env");
  loadEnv({ path: envFilePath, override: true });
  return envFilePath;
}

export function resolveAuth(flags: {
  figmaApiKey?: string;
  figmaApiKeys?: string;
  figmaApiKeysFile?: string;
  figmaOauthToken?: string;
}): FigmaAuthOptions {
  const figmaApiKeys = resolveApiKeyListSource(flags);
  const figmaApiKey = figmaApiKeys.value[0] ?? "";
  const figmaOauthToken = resolve(flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");

  const useOAuth = Boolean(figmaOauthToken.value);
  const auth: FigmaAuthOptions = {
    figmaApiKey,
    figmaApiKeys: figmaApiKeys.value,
    figmaOAuthToken: figmaOauthToken.value,
    useOAuth,
  };

  return auth;
}

/**
 * Thrown for user-fixable input errors (missing credentials, missing file key,
 * etc.). CLI entry points catch this and print the bare message with exit 1,
 * distinct from unexpected crashes that get a "Failed to start server:" prefix
 * and stack trace. Throwing (vs. process.exit) keeps validators pure and safe
 * for library consumers of `~/mcp-server`.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Fail fast when global credentials are required but missing. HTTP mode skips
 * this check so it can accept per-request `X-Figma-Token` headers; stdio and
 * the `fetch` CLI have no way to receive request-time auth and must have
 * something resolvable at startup or they'd just defer the failure to the
 * first tool call with a misleading "send X-Figma-Token" message.
 */
export function requireGlobalCredentials(auth: FigmaAuthOptions): void {
  if (auth.figmaApiKey || auth.figmaApiKeys.length > 0 || auth.figmaOAuthToken) return;
  throw new UsageError(
    "Either FIGMA_API_KEY / FIGMA_API_KEYS or FIGMA_OAUTH_TOKEN is required (via CLI argument or .env file)",
  );
}

export function getServerConfig(flags: ServerFlags): ServerConfig {
  // Load .env before resolving env-backed values
  const envFilePath = loadEnvFile(flags.env);
  const envFileSource: Source = flags.env !== undefined ? "cli" : "default";

  // Auth
  const auth = resolveAuth(flags);

  // Resolve config values: CLI flag → env var → default
  const figmaApiKey = resolve(flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  const figmaApiKeys = resolveApiKeyListSource(flags);
  const figmaOauthToken = resolve(flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");
  const port = resolve(flags.port, envInt("FRAMELINK_PORT", "PORT"), 3333);
  const host = resolve(flags.host, envStr("FRAMELINK_HOST"), "127.0.0.1");
  const skipImageDownloads = resolve(
    flags.skipImageDownloads,
    envBool("SKIP_IMAGE_DOWNLOADS"),
    false,
  );
  const envImageDir = envStr("IMAGE_DIR");
  const imageDir = resolve(
    flags.imageDir ? resolvePath(expandTilde(flags.imageDir)) : undefined,
    envImageDir ? resolvePath(expandTilde(envImageDir)) : undefined,
    process.cwd(),
  );
  const cacheDir = resolve(
    flags.cacheDir ? resolvePath(expandTilde(flags.cacheDir)) : undefined,
    envStr("FIGMA_CACHE_DIR") ? resolvePath(expandTilde(envStr("FIGMA_CACHE_DIR")!)) : undefined,
    defaultFigmaCacheDir(),
  );
  const cacheTtlSeconds = resolve(
    flags.cacheTtlSeconds,
    envInt("FIGMA_CACHE_TTL_SECONDS"),
    24 * 60 * 60,
  );
  const normalizedCacheTtlSeconds = normalizeFigmaCacheTtl(cacheTtlSeconds.value);

  // Only resolve explicit proxy config here. Standard env vars (HTTPS_PROXY, HTTP_PROXY,
  // NO_PROXY) are handled by undici's EnvHttpProxyAgent at the dispatcher level, which
  // correctly respects NO_PROXY exclusions.
  const proxy = resolve(flags.proxy, envStr("FIGMA_PROXY"), undefined);

  // --format wins; --json is a back-compat alias for --format=json. Invalid
  // user-supplied values fail loudly at startup rather than silently coercing.
  const formatFromFlag =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : undefined);
  const formatFromEnv = parseOutputFormat(envStr("OUTPUT_FORMAT"), "OUTPUT_FORMAT");
  const outputFormat = resolve<OutputFormat>(formatFromFlag, formatFromEnv, "yaml");

  const isStdioMode = flags.stdio === true;

  const noTelemetry = flags.noTelemetry ?? false;
  const telemetrySource: Source =
    flags.noTelemetry === true
      ? "cli"
      : process.env.FRAMELINK_TELEMETRY !== undefined || process.env.DO_NOT_TRACK !== undefined
        ? "env"
        : "default";

  const configSources: Record<string, Source> = {
    envFile: envFileSource,
    figmaApiKey: figmaApiKey.source,
    figmaApiKeys: figmaApiKeys.source,
    figmaOauthToken: figmaOauthToken.source,
    port: port.source,
    host: host.source,
    proxy: proxy.source,
    outputFormat: outputFormat.source,
    skipImageDownloads: skipImageDownloads.source,
    imageDir: imageDir.source,
    cacheDir: cacheDir.source,
    cacheTtlSeconds: cacheTtlSeconds.source,
    telemetry: telemetrySource,
  };

  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(`- ENV_FILE: ${envFilePath} (source: ${configSources.envFile})`);
    if (auth.useOAuth) {
      console.log(
        `- FIGMA_OAUTH_TOKEN: ${maskApiKey(auth.figmaOAuthToken)} (source: ${configSources.figmaOauthToken})`,
      );
      console.log("- Authentication Method: OAuth Bearer Token");
    } else if (auth.figmaApiKeys.length > 1) {
      console.log(
        `- FIGMA_API_KEYS: ${auth.figmaApiKeys.length} tokens configured (source: ${configSources.figmaApiKeys})`,
      );
      console.log("- Authentication Method: Personal Access Tokens (rotating on 429)");
    } else if (auth.figmaApiKeys.length === 1) {
      console.log(
        `- FIGMA_API_KEY: ${maskApiKey(auth.figmaApiKeys[0])} (source: ${configSources.figmaApiKeys})`,
      );
      console.log("- Authentication Method: Personal Access Token (X-Figma-Token)");
    } else if (auth.figmaApiKey) {
      console.log(
        `- FIGMA_API_KEY: ${maskApiKey(auth.figmaApiKey)} (source: ${configSources.figmaApiKey})`,
      );
      console.log("- Authentication Method: Personal Access Token (X-Figma-Token)");
    } else {
      console.log("- Authentication Method: Per-request X-Figma-Token header");
    }
    console.log(`- FRAMELINK_PORT: ${port.value} (source: ${configSources.port})`);
    console.log(`- FRAMELINK_HOST: ${host.value} (source: ${configSources.host})`);
    console.log(`- PROXY: ${proxy.value ? "configured" : "none"} (source: ${configSources.proxy})`);
    console.log(`- OUTPUT_FORMAT: ${outputFormat.value} (source: ${configSources.outputFormat})`);
    console.log(
      `- SKIP_IMAGE_DOWNLOADS: ${skipImageDownloads.value} (source: ${configSources.skipImageDownloads})`,
    );
    console.log(`- IMAGE_DIR: ${imageDir.value} (source: ${configSources.imageDir})`);
    console.log(`- CACHE_DIR: ${cacheDir.value} (source: ${configSources.cacheDir})`);
    console.log(
      `- CACHE_TTL_SECONDS: ${normalizedCacheTtlSeconds} (source: ${configSources.cacheTtlSeconds})`,
    );
    const telemetryEnabled = resolveTelemetryEnabled(noTelemetry);
    console.log(
      `- TELEMETRY: ${telemetryEnabled ? "enabled" : "disabled"} (source: ${configSources.telemetry})`,
    );
    console.log();
  }

  return {
    auth,
    port: port.value,
    host: host.value,
    proxy: proxy.value,
    outputFormat: outputFormat.value,
    skipImageDownloads: skipImageDownloads.value,
    imageDir: imageDir.value,
    cacheDir: cacheDir.value,
    cacheTtlSeconds: normalizedCacheTtlSeconds,
    isStdioMode,
    noTelemetry,
    configSources,
  };
}
