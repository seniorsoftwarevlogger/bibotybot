import { describe, it, expect } from "vitest";
import { helpText, rulesList, rulesText } from "../../src/help.ts";
import { QUARANTINE_CHAT } from "../../src/lib.ts";
import { EMOJI_LIMIT, RANKS, THRESHOLDS } from "../../src/permissions.ts";

describe("rulesText", () => {
  it("quotes the limits the gates actually enforce", () => {
    const text = rulesText("Test Chat");
    expect(text).toContain("Правила чата «Test Chat»");
    expect(text).toContain(`после ${THRESHOLDS.react} сообщений`);
    expect(text).toContain(`после ${THRESHOLDS.link} сообщений`);
    expect(text).toContain(`после ${THRESHOLDS.media} сообщений`);
    expect(text).toContain(`${EMOJI_LIMIT} кастомных эмодзи`);
    expect(text).toContain(QUARANTINE_CHAT);
    expect(text).toContain("/stat");
  });

  it("lists every rank with the message count it needs", () => {
    const text = rulesText();
    for (const rank of RANKS) {
      expect(text).toContain(`${rank.tag} — ${rank.count}`);
    }
    expect(text).not.toContain("«");
  });
});

describe("rulesList", () => {
  it("is the shared list the captcha and /rules both quote", () => {
    const list = rulesList();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((line) => line.startsWith("•"))).toBe(true);
    expect(rulesText()).toContain(list[0]);
  });
});

describe("helpText", () => {
  it("points at every member-facing command", () => {
    const text = helpText();
    expect(text).toContain("/rules");
    expect(text).toContain("/stat");
    expect(text).toContain("/help");
  });
});
