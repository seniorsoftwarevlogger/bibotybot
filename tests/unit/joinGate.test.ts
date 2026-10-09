import { describe, it, expect } from "vitest";
import {
  captchaText,
  joinEvent,
  parseJoinGateCallback,
} from "../../src/joinGate.ts";
import { THRESHOLDS } from "../../src/permissions.ts";

describe("joinEvent", () => {
  it("detects joins from outside and from a ban", () => {
    expect(joinEvent("member", "left")).toBe("join");
    expect(joinEvent("member", "kicked")).toBe("join");
  });

  it("detects leaving and being kicked", () => {
    expect(joinEvent("left", "member")).toBe("leave");
    expect(joinEvent("kicked", "member")).toBe("leave");
  });

  it("returns other for promotions and restrictions", () => {
    expect(joinEvent("administrator", "member")).toBe("other");
    expect(joinEvent("restricted", "left")).toBe("other");
    expect(joinEvent("member", "member")).toBe("other");
  });
});

describe("parseJoinGateCallback", () => {
  it("parses a chat id and user id", () => {
    expect(parseJoinGateCallback("joingate:-1001234567890:42")).toEqual({
      chatId: -1001234567890,
      userId: 42,
    });
  });

  it("rejects other callback data", () => {
    expect(parseJoinGateCallback("joingate:42")).toBeNull();
    expect(parseJoinGateCallback("modunban:-100:42")).toBeNull();
    expect(parseJoinGateCallback("joingate:abc:42")).toBeNull();
  });
});

describe("captchaText", () => {
  it("greets with the chat title, explains the hold, and lists the rules", () => {
    const text = captchaText("Senior Software Vlogger");
    expect(text).toContain("«Senior Software Vlogger»");
    expect(text).toContain("удалено и сохранено в карантине");
    expect(text).toContain("нажмите кнопку");
    expect(text).toContain(`после ${THRESHOLDS.react} сообщений`);
    expect(text).toContain(`после ${THRESHOLDS.link} сообщений`);
    expect(text).toContain(`после ${THRESHOLDS.media} сообщений`);
    expect(text).toContain("5 кастомных эмодзи");
  });

  it("greets without a title", () => {
    expect(captchaText(undefined)).toContain("Добро пожаловать!");
    expect(captchaText(undefined)).not.toContain("«");
  });
});
