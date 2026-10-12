import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

test("installer enables the cached plugin and preserves unrelated user settings on rerun", async (t) => {
  const home = createTmpDir("opencode-install");
  t.after(() => cleanupTmpDir(home));
  const config = path.join(home, ".claude");
  const marketplace = path.join(config, "plugins/marketplaces/armedi-opencode-plugin-cc");
  fs.mkdirSync(marketplace, { recursive: true });
  fs.cpSync(".claude-plugin", path.join(marketplace, ".claude-plugin"), { recursive: true });
  fs.cpSync("plugins", path.join(marketplace, "plugins"), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  const pluginID = "opencode@armedi-opencode-plugin-cc";
  const settingsPath = path.join(config, "settings.json");
  const unrelated = { env: { EXISTING: "keep" }, enabledPlugins: { "other@marketplace": true, "disabled@marketplace": false } };
  fs.writeFileSync(settingsPath, JSON.stringify({ ...unrelated, enabledPlugins: { ...unrelated.enabledPlugins, [pluginID]: false } }));

  // Only skip network-dependent dependency installation. Settings and registry
  // writes run through the real installer, not a mocked persistence layer.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCommand("bash", [path.resolve("install.sh")], { env });
    assert.equal(result.exitCode, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings, { ...unrelated, enabledPlugins: { ...unrelated.enabledPlugins, [pluginID]: true } });
    const registry = JSON.parse(fs.readFileSync(path.join(config, "plugins/installed_plugins.json"), "utf8"));
    assert.ok(fs.existsSync(path.join(registry.plugins[pluginID][0].installPath, "commands/setup.md")));
  }
});
