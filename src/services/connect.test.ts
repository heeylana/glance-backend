import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { bindingDecision, hashCode, maskUser, newCode, sessionStatus, userTag } from "./connect.js";
import { connectMessage, verifySignature } from "./auth.js";

describe("maskUser", () => {
  it("keeps the country code and the last four digits of a WhatsApp number", () => {
    expect(maskUser("whatsapp", "447700900123")).toBe("+44 •••• 0123");
    expect(maskUser("whatsapp", "15551234567")).toBe("+15 •••• 4567");
  });
  it("never shows a Telegram id whole", () => {
    expect(maskUser("telegram", "123456789")).toBe("telegram user •••789");
  });
  it("tags a user for the logs without the number", () => {
    const tag = userTag("whatsapp", "447700900123");
    expect(tag).toMatch(/^whatsapp:[0-9a-f]{6}$/);
    expect(tag).not.toContain("0123");
    expect(userTag("whatsapp", "447700900123")).toBe(tag);
  });
});

describe("codes", () => {
  it("are at least 128 bits and never stored as themselves", () => {
    const code = newCode();
    expect(bs58.decode(code).length).toBe(16);
    expect(hashCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(code)).not.toContain(code);
    expect(newCode()).not.toBe(code);
  });
});

describe("sessionStatus", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const live = new Date("2026-10-08T12:10:00Z");
  it("is pending until verified, verified until used, and expired after its time whatever else happened", () => {
    expect(sessionStatus({ expiresAt: live, verifiedAt: null, usedAt: null }, now)).toBe("pending");
    expect(sessionStatus({ expiresAt: live, verifiedAt: now, usedAt: null }, now)).toBe("verified");
    expect(sessionStatus({ expiresAt: live, verifiedAt: now, usedAt: now }, now)).toBe("used");
    expect(sessionStatus({ expiresAt: new Date("2026-10-08T11:59:59Z"), verifiedAt: now, usedAt: null }, now)).toBe("expired");
  });
  it("a used code stays used even after it would have expired", () => {
    expect(sessionStatus({ expiresAt: new Date("2026-10-08T11:00:00Z"), verifiedAt: now, usedAt: now }, now)).toBe("used");
  });
});

describe("connect message", () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const code = newCode();
  const message = connectMessage({ wallet, code, channel: "whatsapp", maskedUser: "+44 •••• 0123" });
  const sign = (m: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey));

  it("names the code and the masked number, and says nothing moves", () => {
    expect(message).toContain(`Code: ${code}`);
    expect(message).toContain("WhatsApp: +44 •••• 0123");
    expect(message).toContain(`Wallet: ${wallet}`);
    expect(message).toContain("moves nothing");
  });
  it("verifies a signature over the exact message, base58 or base64", () => {
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    expect(verifySignature(wallet, message, bs58.encode(sig))).toBe(true);
    expect(verifySignature(wallet, message, Buffer.from(sig).toString("base64"))).toBe(true);
  });
  it("refuses another code, another number, another wallet, or junk", () => {
    const sig = sign(message);
    expect(verifySignature(wallet, connectMessage({ wallet, code: newCode(), channel: "whatsapp", maskedUser: "+44 •••• 0123" }), sig)).toBe(false);
    expect(verifySignature(wallet, connectMessage({ wallet, code, channel: "whatsapp", maskedUser: "+44 •••• 9999" }), sig)).toBe(false);
    expect(verifySignature(Keypair.generate().publicKey.toBase58(), message, sig)).toBe(false);
    expect(verifySignature(wallet, message, "not-a-signature")).toBe(false);
    expect(verifySignature("not-a-key", message, sig)).toBe(false);
  });
});

describe("bindingDecision", () => {
  const wallet = "WalletA";
  it("binds a fresh number to a fresh wallet without ceremony", () => {
    expect(bindingDecision({ existing: null, wallet, othersForWallet: 0, confirmReplace: false, confirmMulti: false })).toEqual({ ok: true, replaces: false });
  });
  it("re-binding the same wallet to the same number is not a replacement", () => {
    expect(bindingDecision({ existing: { owner: wallet }, wallet, othersForWallet: 0, confirmReplace: false, confirmMulti: false })).toEqual({ ok: true, replaces: false });
  });
  it("replacing another wallet on this number needs a yes", () => {
    expect(bindingDecision({ existing: { owner: "WalletB" }, wallet, othersForWallet: 0, confirmReplace: false, confirmMulti: false })).toEqual({ ok: false, code: "needs_confirm_replace" });
    expect(bindingDecision({ existing: { owner: "WalletB" }, wallet, othersForWallet: 0, confirmReplace: true, confirmMulti: false })).toEqual({ ok: true, replaces: true });
  });
  it("a wallet already on another number needs a yes, default no", () => {
    expect(bindingDecision({ existing: null, wallet, othersForWallet: 1, confirmReplace: false, confirmMulti: false })).toEqual({ ok: false, code: "needs_confirm_multi" });
    expect(bindingDecision({ existing: null, wallet, othersForWallet: 1, confirmReplace: false, confirmMulti: true })).toEqual({ ok: true, replaces: false });
  });
  it("asks about the replacement before the second number", () => {
    expect(bindingDecision({ existing: { owner: "WalletB" }, wallet, othersForWallet: 2, confirmReplace: false, confirmMulti: false })).toEqual({ ok: false, code: "needs_confirm_replace" });
  });
});
