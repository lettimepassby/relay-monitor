import test from "node:test";
import assert from "node:assert/strict";
import { describeFetchError } from "./fetch-error.js";

const fetchFailed = (cause) => new TypeError("fetch failed", { cause });

test("fetch failed 拼上 cause 的错误代码", () => {
  const dnsErr = Object.assign(new Error("getaddrinfo EAI_AGAIN example.com"), { code: "EAI_AGAIN" });
  const e = describeFetchError(fetchFailed(dnsErr));
  assert.equal(e.message, "fetch failed (EAI_AGAIN)");
  assert.equal(e.cause, dnsErr);
});

test("多地址连接失败（AggregateError）合并去重各地址的代码", () => {
  const agg = new AggregateError([
    Object.assign(new Error("a"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("b"), { code: "ENETUNREACH" }),
    Object.assign(new Error("c"), { code: "ETIMEDOUT" }),
  ]);
  assert.equal(describeFetchError(fetchFailed(agg)).message, "fetch failed (ETIMEDOUT/ENETUNREACH)");
});

test("undici 自带错误类型没有 code 时用错误名", () => {
  class SocketError extends Error { constructor() { super("other side closed"); this.name = "SocketError"; } }
  assert.equal(describeFetchError(fetchFailed(new SocketError())).message, "fetch failed (SocketError)");
});

test("超时中止、HTTP 层错误和无原因的错误原样返回", () => {
  const abort = new DOMException("This operation was aborted", "AbortError");
  assert.equal(describeFetchError(abort), abort);
  const other = new Error("HTTP 500");
  assert.equal(describeFetchError(other), other);
  const bare = fetchFailed(new Error("plain"));
  assert.equal(describeFetchError(bare), bare);
  assert.equal(describeFetchError("x"), "x");
});
