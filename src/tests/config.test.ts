import os from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envBool, envInt, envStr, expandTilde, parseApiKeyList, resolve } from "~/config.js";

describe("resolve", () => {
  it("CLI flag wins over env and default", () => {
    const result = resolve("from-cli", "from-env", "fallback");
    expect(result).toEqual({ value: "from-cli", source: "cli" });
  });

  it("env wins over default when flag is undefined", () => {
    const result = resolve(undefined, "from-env", "fallback");
    expect(result).toEqual({ value: "from-env", source: "env" });
  });

  it("default is used when both flag and env are undefined", () => {
    const result = resolve(undefined, undefined, "fallback");
    expect(result).toEqual({ value: "fallback", source: "default" });
  });

  it("preserves falsy flag values (false, 0) instead of falling through", () => {
    expect(resolve(false, true, true)).toEqual({ value: false, source: "cli" });
    expect(resolve(0, 42, 99)).toEqual({ value: 0, source: "cli" });
  });
});

describe("envStr", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the env var value when set", () => {
    vi.stubEnv("TEST_STR", "hello");
    expect(envStr("TEST_STR")).toBe("hello");
  });

  it("returns undefined when env var is not set", () => {
    expect(envStr("TEST_STR_MISSING")).toBeUndefined();
  });

  it("returns undefined when env var is empty string", () => {
    vi.stubEnv("TEST_STR_EMPTY", "");
    expect(envStr("TEST_STR_EMPTY")).toBeUndefined();
  });
});

describe("envInt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns parsed integer when set", () => {
    vi.stubEnv("TEST_INT", "42");
    expect(envInt("TEST_INT")).toBe(42);
  });

  it("tries names in order and returns first match", () => {
    vi.stubEnv("TEST_INT_B", "99");
    expect(envInt("TEST_INT_A", "TEST_INT_B")).toBe(99);
  });

  it("returns undefined when none of the names are set", () => {
    expect(envInt("NOPE_A", "NOPE_B")).toBeUndefined();
  });
});

describe("envBool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true for "true"', () => {
    vi.stubEnv("TEST_BOOL", "true");
    expect(envBool("TEST_BOOL")).toBe(true);
  });

  it('returns false for "false"', () => {
    vi.stubEnv("TEST_BOOL", "false");
    expect(envBool("TEST_BOOL")).toBe(false);
  });

  it("returns undefined for any other value", () => {
    vi.stubEnv("TEST_BOOL", "yes");
    expect(envBool("TEST_BOOL")).toBeUndefined();
  });

  it("returns undefined when not set", () => {
    expect(envBool("TEST_BOOL_MISSING")).toBeUndefined();
  });
});

describe("parseApiKeyList", () => {
  it("splits comma and newline separated keys", () => {
    expect(parseApiKeyList("a,b\nc")).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries and trims whitespace", () => {
    expect(parseApiKeyList("  a  ,\n , b ")).toEqual(["a", "b"]);
  });
});

describe("expandTilde", () => {
  const home = os.homedir();

  it("将 ~ 单独出现时展开为主目录", () => {
    expect(expandTilde("~")).toBe(home);
  });

  it("将 ~/ 开头的路径展开为主目录 + 剩余部分", () => {
    expect(expandTilde("~/foo/bar")).toBe(`${home}/foo/bar`);
  });

  it("将 ~\\ 开头的 Windows 风格路径展开", () => {
    expect(expandTilde("~\\foo\\bar")).toBe(`${home}\\foo\\bar`);
  });

  it("不修改不以 ~ 开头的绝对路径", () => {
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
  });

  it("不修改不以 ~ 开头的相对路径", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("不展开路径中间的 ~", () => {
    expect(expandTilde("/some/~path")).toBe("/some/~path");
  });

  it("常见用例：~/.figma_cache 展开正确", () => {
    expect(expandTilde("~/.figma_cache")).toBe(`${home}/.figma_cache`);
  });

  it("常见用例：~/Code/project/dist/bin.js 展开正确", () => {
    expect(expandTilde("~/Code/project/dist/bin.js")).toBe(`${home}/Code/project/dist/bin.js`);
  });
});
