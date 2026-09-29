import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { env } from "../config.js";
import { bundledRegistryPath, loadRegistry, registryPath, withCommittedMocks } from "../config/issuers.js";
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

describe("withCommittedMocks", () => {
  const live = { stableMints: ["USDC"], mints: { A: { ticker: "AAPL", v: "live" }, R: { ticker: "META", v: "runtime" } } };
  const committed = { mints: { A: { ticker: "AAPL", v: "committed" }, H: { ticker: "META", v: "harvested" } } };

  it("adds committed mocks the live file lacks, and never overwrites or drops a live one", () => {
    const merged = withCommittedMocks(live, committed);
    expect(merged.mints).toEqual({ A: { ticker: "AAPL", v: "live" }, R: { ticker: "META", v: "runtime" }, H: { ticker: "META", v: "harvested" } });
    expect(merged.stableMints).toEqual(["USDC"]);
  });

  it("returns the live registry untouched when nothing is missing", () => {
    expect(withCommittedMocks(live, { mints: { A: {} } })).toBe(live);
  });
});

describe("loadRegistry with a volume", () => {
  it("sees mocks committed after the volume was seeded, and keeps the ones made on the volume", () => {
    const committed = JSON.parse(readFileSync(bundledRegistryPath("mock"), "utf8")) as { mints: Record<string, unknown> };
    const [dropped, ...kept] = Object.keys(committed.mints);
    const file = join(dir, "old-volume", "issuers.mock.json");
    env.ISSUER_REGISTRY_FILE = file;
    try {
      registryPath("mock"); // seeds the volume
      const onVolume = JSON.parse(readFileSync(file, "utf8")) as { mints: Record<string, unknown> };
      // An old volume: seeded before `dropped` was committed, with one mock made on it since.
      delete onVolume.mints[dropped!];
      onVolume.mints["RuntimeMock1111111111111111111111111111111"] = { ticker: "META", issuer: "xStocks", decimals: 8, tokenProgram: "token-2022", referenceMint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", issuerDelegate: null };
      writeFileSync(file, JSON.stringify(onVolume));
      const reg = loadRegistry(true);
      expect(reg.byMint.has(dropped!)).toBe(true);
      expect(reg.byMint.has("RuntimeMock1111111111111111111111111111111")).toBe(true);
      for (const m of kept) expect(reg.byMint.has(m)).toBe(true);
      // Merged in memory only: the volume file is left as it was.
      expect(JSON.parse(readFileSync(file, "utf8")).mints[dropped!]).toBeUndefined();
    } finally {
      env.ISSUER_REGISTRY_FILE = undefined;
      loadRegistry(true);
    }
  });
});
