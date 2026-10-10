import { describe, expect, it } from "vitest";
import { parseChannelUser, parseClients, secretHash } from "./_auth.js";

describe("parseClients", () => {
  it("reads id:secret pairs and their webhooks, hashing the secret", () => {
    const { clients, rejected } = parseClients("whatsapp:0123456789abcdef0123, telegram:abcdefghijklmnopqrstuvwxyz", "whatsapp=https://bot.example/hook");
    expect([...clients.keys()]).toEqual(["whatsapp", "telegram"]);
    expect(clients.get("whatsapp")!.secretHash.equals(secretHash("0123456789abcdef0123"))).toBe(true);
    expect(clients.get("whatsapp")!.webhookUrl).toBe("https://bot.example/hook");
    expect(clients.get("telegram")!.webhookUrl).toBeNull();
    expect(rejected).toEqual([]);
  });
  it("drops a short secret or a malformed pair and says which", () => {
    const { clients, rejected } = parseClients("short:abc,:nosecretid,ok:0123456789abcdef", undefined);
    expect([...clients.keys()]).toEqual(["ok"]);
    expect(rejected).toEqual(["short", "?"]);
  });
  it("is empty when unset", () => {
    expect(parseClients(undefined, undefined).clients.size).toBe(0);
  });
});

describe("parseChannelUser", () => {
  it("takes channel:id for a known channel", () => {
    expect(parseChannelUser("whatsapp:447700900123")).toEqual({ channel: "whatsapp", channelUserId: "447700900123" });
    expect(parseChannelUser("Telegram:12345")).toEqual({ channel: "telegram", channelUserId: "12345" });
  });
  it("refuses an unknown channel, a missing id, or junk", () => {
    expect(parseChannelUser("sms:447700900123")).toBeNull();
    expect(parseChannelUser("whatsapp:")).toBeNull();
    expect(parseChannelUser("whatsapp:has spaces")).toBeNull();
    expect(parseChannelUser(undefined)).toBeNull();
  });
});
