import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { env } from "../config.js";
import { registryPath } from "../config/issuers.js";
import { loadKeypair } from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "glance-keys-"));
const kp = Keypair.generate();
const json = JSON.stringify(Array.from(kp.secretKey));

describe("loadKeypair", () => {
  it("reads a key file's path or the file's contents, so a key can live in a sealed variable", () => {
    const file = join(dir, "agent.json");
    writeFileSync(file, json);
    expect(loadKeypair(file).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(json).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(`  ${json}\n`).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it("names the variable and never repeats the key in its errors", () => {
    const broken = json.slice(0, -5);
    expect(() => loadKeypair(broken, "AGENT_KEYPAIR")).toThrow(/^AGENT_KEYPAIR: not a Solana key/);
    try {
      loadKeypair(broken, "AGENT_KEYPAIR");
    } catch (e) {
      expect((e as Error).message).not.toContain(json.slice(1, 12));
    }
    expect(() => loadKeypair("[1,2,3]", "DESK_KEYPAIR")).toThrow(/^DESK_KEYPAIR: not a Solana key/);
    expect(() => loadKeypair(join(dir, "missing.json"), "DESK_KEYPAIR")).toThrow(/^DESK_KEYPAIR: no key file at /);
  });
});

describe("registryPath", () => {
  it("keeps the mock registry where ISSUER_REGISTRY_FILE says, starting from the bundled one", () => {
    const bundled = registryPath("mock");
    const file = join(dir, "volume", "issuers.mock.json");
    env.ISSUER_REGISTRY_FILE = file;
    try {
      expect(registryPath("mock")).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(readFileSync(bundled, "utf8"));
      expect(registryPath("registry")).not.toBe(file);
    } finally {
      env.ISSUER_REGISTRY_FILE = undefined;
    }
  });
});
