import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { selectLocalDirectory } from "../src/server/directory-picker.js";

test("macOS directory picker passes the initial path as an argument and returns the selected path", async () => {
  const initialDirectory = path.resolve("/tmp/product wiki");
  const selectedDirectory = path.resolve("/tmp/product wiki selected");
  const result = await selectLocalDirectory(initialDirectory, {
    platform: "darwin",
    async run(command, args) {
      assert.equal(command, "osascript");
      assert.equal(args[0], "-e");
      assert.equal(args.at(-1), initialDirectory);
      return { stdout: `${selectedDirectory}\n`, stderr: "" };
    }
  });

  assert.equal(result, selectedDirectory);
});

test("directory picker treats native cancellation as an empty selection", async () => {
  const cancelled = Object.assign(new Error("User canceled. (-128)"), { code: 1 });
  const result = await selectLocalDirectory(undefined, {
    platform: "darwin",
    async run() {
      throw cancelled;
    }
  });

  assert.equal(result, undefined);
});

test("directory picker reports a missing native command clearly", async () => {
  const missing = Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    selectLocalDirectory(undefined, {
      platform: "linux",
      async run() {
        throw missing;
      }
    }),
    /当前系统缺少目录选择器命令：zenity/
  );
});

test("Windows directory picker keeps a hostile path out of PowerShell command text", async () => {
  const hostilePath = "C:\\wiki'; Start-Process calc; #'";
  const hostilePathBase64 = Buffer.from(path.resolve(hostilePath), "utf8").toString("base64");
  const result = await selectLocalDirectory(hostilePath, {
    platform: "win32",
    async run(command, args) {
      assert.equal(command, "powershell.exe");
      assert.equal(args.at(-2), "-EncodedCommand");
      assert.equal(args.some((argument) => argument.includes(hostilePath)), false);
      const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
      assert.equal(script.includes(hostilePath), false);
      assert.equal(script.includes(`FromBase64String('${hostilePathBase64}')`), true);
      return { stdout: "", stderr: "" };
    }
  });

  assert.equal(result, undefined);
});
