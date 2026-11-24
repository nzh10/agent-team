import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AGENT_PRESETS } from "../../src/config/presets";
import { loadConfig } from "../../src/config/config";
import { loadSettings, saveSettings } from "../../src/workspace/state";

let dir: string;

function writeConfig(toml: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  fs.writeFileSync(path.join(d, "config.toml"), toml);
  return d;
}

beforeAll(() => {
  dir = writeConfig(`
[server]
port = 9800

[hosts.local]
label = "Local"
type = "local"

[accounts.work]
oauth_token = "legacy-token"

[cursor]
api_key = "legacy-key"
`);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("ignores legacy account and cursor sections", () => {
    expect(loadConfig(dir)).not.toHaveProperty("accounts");
    expect(loadConfig(dir)).not.toHaveProperty("cursor");
  });

  it("reads an optional user-facing language", () => {
    expect(loadConfig(dir).user).not.toHaveProperty("language");
    expect(loadConfig(writeConfig('[user]\nlanguage = " Icelandic "\n')).user.language).toBe(
      "Icelandic",
    );
  });

  it("reports the provider migration without exposing the section name or credentials", () => {
    const d = writeConfig(
      '[providers.sensitive-name]\napi_key = "private-test-token"\nbase_url = "https://secret.example"\n',
    );
    expect(() => loadConfig(d)).toThrow(
      /^\[providers\.\*\] is no longer supported\. Migrate custom Pi providers to ~\/\.pi\/agent\/models\.json and remove the \[providers\.\*\] tables from config\.toml\.$/,
    );
  });

  it("reads the lead's default model and effort", () => {
    const d = writeConfig(`[projects]\nmodel = "provider/model"\neffort = "high"\n`);
    expect(loadConfig(d).projects).toEqual({ model: "provider/model", effort: "high" });
    expect(loadConfig(dir).projects).toEqual({});
  });

  it("reads user, lead and agent identities without changing built-in defaults", () => {
    for (const source of ["", "agent_presets = []"]) {
      expect(loadConfig(writeConfig(source))).toMatchObject({
        user: { name: "You", avatar: "avatars/header.jpg" },
        presets: AGENT_PRESETS,
      });
    }
    const cfg = loadConfig(
      writeConfig(`
[user]
name="Ada"
avatar="avatars/me.png"
[projects]
lead_name="Boss"
lead_avatar="B"
lead_color="red"
[[agent_presets]]
name="One"
avatar="1"
color="blue"
model="p/model"
effort="high"
[[agent_presets]]
name="Two"
avatar="2"
color="green"`),
    );
    expect(cfg.user).toEqual({ name: "Ada", avatar: "avatars/me.png" });
    expect(cfg.projects).toEqual({ lead_name: "Boss", lead_avatar: "B", lead_color: "red" });
    expect(cfg.presets).toEqual([
      { name: "One", avatar: "1", color: "blue", model: "p/model", effort: "high" },
      { name: "Two", avatar: "2", color: "green" },
    ]);
  });

  it("reads optional preset dispatch hints, trimming and ignoring blank values", () => {
    const cfg = loadConfig(
      writeConfig(`
[[agent_presets]]
name="Scout"
avatar="S"
color="blue"
when_to_use="  Broad codebase exploration  "
[[agent_presets]]
name="Plain"
avatar="P"
color="green"
[[agent_presets]]
name="Empty"
avatar="E"
color="red"
when_to_use=""
[[agent_presets]]
name="Blank"
avatar="B"
color="yellow"
when_to_use="   "`),
    );
    expect(cfg.presets).toEqual([
      {
        name: "Scout",
        avatar: "S",
        color: "blue",
        when_to_use: "Broad codebase exploration",
      },
      { name: "Plain", avatar: "P", color: "green" },
      { name: "Empty", avatar: "E", color: "red" },
      { name: "Blank", avatar: "B", color: "yellow" },
    ]);
  });

  it("reads Pi and restart settings", () => {
    const d = writeConfig(`
[server]
restart_command = ["launchctl", "kickstart", "-k", "gui/501/test"]
[pi]
packages = ["pkg:a", "pkg:b"]
exclude_packages = ["pkg:c"]
default_model = "provider/model"
default_effort = "high"
offline = true
`);
    expect(loadConfig(d).server.restart_command).toEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/test",
    ]);
    expect(loadConfig(d).pi).toEqual({
      packages: ["pkg:a", "pkg:b"],
      exclude_packages: ["pkg:c"],
      default_model: "provider/model",
      default_effort: "high",
      offline: true,
    });
  });
});

describe("runtime settings", () => {
  it("round-trips commands", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
    const commands = [{ name: "context", description: "Context", argumentHint: "" }];
    saveSettings(d, { commands });
    expect(loadSettings(d).commands).toEqual(commands);
  });
});

describe("workspace housekeeping config", () => {
  it("defaults archive_after_days to 14 and accepts an override (0 disables)", () => {
    expect(loadConfig(dir).workspace.archive_after_days).toBe(14);
    expect(
      loadConfig(writeConfig(`[workspace]\narchive_after_days = 0\n`)).workspace.archive_after_days,
    ).toBe(0);
    expect(
      loadConfig(writeConfig(`[workspace]\narchive_after_days = 30\n`)).workspace
        .archive_after_days,
    ).toBe(30);
  });
});

describe("auth config", () => {
  it("a complete [auth] enables login", () => {
    const d = writeConfig(`[auth]\nusername = "u"\npassword = "p"\nsession_secret = "s"\n`);
    expect(loadConfig(d).auth).toMatchObject({ username: "u", max_age_days: 30 });
  });

  it("a half-filled [auth] is an error, not a server without login", () => {
    const d = writeConfig(`[auth]\nusername = "u"\npassword = "p"\n`);
    expect(() => loadConfig(d)).toThrow(/session_secret/);
  });

  it("no [auth] section means no login", () => {
    expect(loadConfig(dir).auth).toBeNull();
  });
});
