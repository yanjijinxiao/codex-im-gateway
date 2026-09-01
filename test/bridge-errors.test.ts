import assert from "node:assert/strict";
import test from "node:test";

import {
  markMessageHandlingErrorReported,
  userFacingMessageHandlingError,
  wasMessageHandlingErrorReported
} from "../src/bridge/errors.js";
import { CodexThreadStateError } from "../src/codex/backend.js";

test("returns actionable guidance for the Windows sandbox launch failure", () => {
  const message = userFacingMessageHandlingError(
    new Error("windows sandbox: CreateProcessAsUserW failed: 1312")
  );

  assert.match(message, /codexExecSandbox/);
  assert.match(message, /danger-full-access/);
  assert.match(message, /risk|风险/i);
});

test("returns a retry hint for timeouts", () => {
  assert.match(
    userFacingMessageHandlingError(new Error("codex exec timed out after 600000ms")),
    /重试/
  );
});

test("returns an actionable DingTalk image download error without exposing details", () => {
  const message = userFacingMessageHandlingError(
    new Error("DingTalk inbound image download failed: signed URL contained secret-code")
  );

  assert.match(message, /已收到钉钉图片/);
  assert.match(message, /消息文件下载权限/);
  assert.doesNotMatch(message, /secret-code/);
});

test("does not expose arbitrary local errors to WeChat", () => {
  const message = userFacingMessageHandlingError(new Error("secret path C:/private/token.txt"));

  assert.doesNotMatch(message, /private|token\.txt/);
  assert.match(message, /本机服务输出/);
});

test("returns explicit lifecycle guidance for archived and missing sessions", () => {
  assert.match(
    userFacingMessageHandlingError(new CodexThreadStateError("archived", "thread-a", "internal")),
    /已归档.*取消归档/
  );
  assert.match(
    userFacingMessageHandlingError(new CodexThreadStateError("missing", "thread-b", "internal")),
    /不存在.*\/sessions/
  );
});

test("tracks errors already reported through an existing channel stream", () => {
  const reported = new Error("reported");
  const untouched = new Error("untouched");

  assert.equal(wasMessageHandlingErrorReported(reported), false);
  markMessageHandlingErrorReported(reported);
  assert.equal(wasMessageHandlingErrorReported(reported), true);
  assert.equal(wasMessageHandlingErrorReported(untouched), false);
  assert.equal(wasMessageHandlingErrorReported("primitive"), false);
});
