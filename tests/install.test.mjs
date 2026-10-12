import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

test("installer prepares the marketplace without installing or enabling plugins, including on rerun", async (t) => {
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
  const installedPath = path.join(config, "plugins/installed_plugins.json");
  const cachePath = path.join(config, "plugins/cache");
  const unrelated = { env: { EXISTING: "keep" }, enabledPlugins: { "other@marketplace": true, "disabled@marketplace": false } };
  fs.writeFileSync(settingsPath, JSON.stringify({ ...unrelated, enabledPlugins: { ...unrelated.enabledPlugins, [pluginID]: false } }));

  // Only skip network-dependent dependency installation. All filesystem changes
  // run through the real installer, not a mocked persistence layer.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runCommand("bash", [path.resolve("install.sh")], { env });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), JSON.stringify({ ...unrelated, enabledPlugins: { ...unrelated.enabledPlugins, [pluginID]: false } }));
    if (attempt === 0) {
      assert.equal(fs.existsSync(installedPath), false);
      assert.equal(fs.existsSync(cachePath), false);
    } else {
      assert.equal(fs.readFileSync(installedPath, "utf8"), '{"version":2,"plugins":{"other@marketplace":[]}}\n');
      assert.equal(fs.readFileSync(path.join(cachePath, "existing"), "utf8"), "keep");
      assert.deepEqual(fs.readdirSync(cachePath), ["existing"]);
    }
    const marketplaces = JSON.parse(fs.readFileSync(path.join(config, "plugins/known_marketplaces.json"), "utf8"));
    assert.equal(marketplaces["armedi-opencode-plugin-cc"].installLocation, marketplace);
    assert.match(result.stdout, /\/plugin install opencode@armedi-opencode-plugin-cc/);
    if (attempt === 0) {
      fs.writeFileSync(installedPath, '{"version":2,"plugins":{"other@marketplace":[]}}\n');
      fs.mkdirSync(cachePath);
      fs.writeFileSync(path.join(cachePath, "existing"), "keep");
    }
  }
});
