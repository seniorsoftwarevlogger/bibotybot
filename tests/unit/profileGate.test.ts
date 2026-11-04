/**
 * The profile gate's decision logic: what combination of signals blocks an
 * account, and what never may.
 */

import { describe, expect, it } from "vitest";
import {
  BAN_SCORE,
  MIN_BAN_SIGNALS,
  SUSPECT_SCORE,
  blockReason,
  extractSignals,
  nameLooksBot,
  scoreProfile,
} from "../../src/profileGate.ts";
import type { ProfileFlags } from "../../src/profileClassifier.ts";

function flags(overrides: Partial<ProfileFlags> = {}): ProfileFlags {
  return {
    intimate_offer: false,
    seductive_avatar: false,
    stock_or_ai_avatar: false,
    bio_external_cta: false,
    bio_earnings_or_crypto: false,
    looks_like_real_person: false,
    confidence: 0.9,
    refused: false,
    model: "gpt-4o-mini",
    tokens: { input: 100, output: 20 },
    latencyMs: 1200,
    ...overrides,
  };
}

function signals(overrides: Partial<ReturnType<typeof extractSignals>> = {}) {
  return {
    hasUsername: true,
    hasBio: true,
    hasPersonalChat: false,
    ratingLevel: null as number | null,
    photoUniqueId: "photo-1" as string | null,
    botLikeName: false,
    ...overrides,
  };
}

describe("nameLooksBot", () => {
  it("accepts ordinary names", () => {
    expect(nameLooksBot("Анна")).toBe(false);
    expect(nameLooksBot("Кристина Соколова")).toBe(false);
    expect(nameLooksBot("dmitry")).toBe(false);
  });

  it("flags digits, emoji, 18+ and keyword stuffing", () => {
    expect(nameLooksBot("Анна 18+")).toBe(true);
    expect(nameLooksBot("Кристина 💋")).toBe(true);
    expect(nameLooksBot("anna_sweet_2004")).toBe(true);
    expect(nameLooksBot("Массаж Досуг Интим Недорого Круглосуточно")).toBe(true);
  });
});

describe("extractSignals", () => {
  it("reads the Telegram-side evidence out of ChatFullInfo", () => {
    const extracted = extractSignals(
      {
        type: "private",
        bio: "Пиши в лс 🔞",
        personal_chat: { id: -1001, title: "Мой канал", username: "mychan" },
        rating: { level: -2, rating: -140, current_level_rating: 0 },
        photo: { big_file_id: "f", big_file_unique_id: "u" },
      },
      { id: 42, first_name: "Анна", username: "anna_2004" }
    );

    expect(extracted).toEqual({
      hasUsername: true,
      hasBio: true,
      hasPersonalChat: true,
      ratingLevel: -2,
      photoUniqueId: "u",
      botLikeName: true,
    });
  });

  it("tolerates a profile without bio, photo or rating", () => {
    const extracted = extractSignals({ type: "private" }, { id: 7, first_name: "Ольга" });

    expect(extracted).toEqual({
      hasUsername: false,
      hasBio: false,
      hasPersonalChat: false,
      ratingLevel: null,
      photoUniqueId: null,
      botLikeName: false,
    });
  });
});

describe("scoreProfile", () => {
  it("blocks the classic account: intimate offer, seductive avatar, own channel", () => {
    const scored = scoreProfile(
      flags({ intimate_offer: true, bio_external_cta: true, seductive_avatar: true }),
      signals({ hasPersonalChat: true })
    );

    expect(scored.verdict).toBe("bot");
    expect(scored.score).toBeGreaterThanOrEqual(BAN_SCORE);
    expect(scored.signals.length).toBeGreaterThanOrEqual(MIN_BAN_SIGNALS);
    expect(scored.reasons).toContain("предложение интимного контента");
  });

  it("blocks a crypto recruiter with a stock avatar and a channel", () => {
    const scored = scoreProfile(
      flags({
        bio_external_cta: true,
        bio_earnings_or_crypto: true,
        stock_or_ai_avatar: true,
      }),
      signals({ hasPersonalChat: true })
    );

    expect(scored.verdict).toBe("bot");
  });

  it("does not block a member for a seductive photo alone", () => {
    const scored = scoreProfile(flags({ seductive_avatar: true }), signals());

    expect(scored.verdict).toBe("clean");
    expect(scored.score).toBeLessThan(SUSPECT_SCORE);
  });

  it("marks an intimate offer without a channel as suspicious but leaves it alone", () => {
    const scored = scoreProfile(
      flags({ intimate_offer: true, seductive_avatar: true }),
      signals()
    );

    expect(scored.verdict).toBe("suspect");
    expect(scored.score).toBeLessThan(BAN_SCORE);
  });

  it("never blocks when the model could not be asked", () => {
    const scored = scoreProfile(null, {
      ...signals({ ratingLevel: -3, botLikeName: true, hasUsername: false }),
      hasPersonalChat: true,
    });

    expect(scored.verdict).toBe("clean");
    expect(scored.score).toBeLessThan(SUSPECT_SCORE);
  });

  it("never blocks on a refused avatar description alone", () => {
    const scored = scoreProfile(flags({ refused: true }), signals());

    expect(scored.verdict).toBe("clean");
    expect(scored.reasons).toContain("откровенный аватар");
  });

  it("steps back from the threshold when the profile looks like a live person", () => {
    // Without the discount these three signals add up to 1.05 — a block.
    const scored = scoreProfile(
      flags({
        intimate_offer: true,
        bio_external_cta: true,
        seductive_avatar: true,
        looks_like_real_person: true,
      }),
      signals()
    );

    expect(scored.verdict).toBe("suspect");
    expect(scored.score).toBeLessThan(BAN_SCORE);
  });

  it("caps the score at 1", () => {
    const scored = scoreProfile(
      flags({
        intimate_offer: true,
        seductive_avatar: true,
        bio_external_cta: true,
        bio_earnings_or_crypto: true,
        stock_or_ai_avatar: true,
        refused: true,
      }),
      signals({ ratingLevel: -1, botLikeName: true, hasUsername: false, hasPersonalChat: true })
    );

    expect(scored.score).toBe(1);
    expect(scored.verdict).toBe("bot");
  });

  it("keeps every single signal below the blocking threshold", () => {
    const single = [
      "intimate_offer",
      "seductive_avatar",
      "stock_or_ai_avatar",
      "bio_external_cta",
      "bio_earnings_or_crypto",
    ] as const;

    for (const name of single) {
      expect(scoreProfile(flags({ [name]: true }), signals()).verdict).not.toBe("bot");
    }

    const telegramOnly = [
      signals({ ratingLevel: -5 }),
      signals({ botLikeName: true }),
      signals({ hasUsername: false }),
      signals({ hasPersonalChat: true }),
    ];
    for (const alone of telegramOnly) {
      expect(scoreProfile(flags(), alone).verdict).not.toBe("bot");
    }
  });

  it("reports only the strong signals as reasons", () => {
    const scored = scoreProfile(flags(), signals({ hasUsername: false, hasPersonalChat: true }));

    expect(scored.reasons).toEqual([]);
    expect(scored.signals).toEqual(expect.arrayContaining(["personal_channel", "no_username"]));
  });
});

describe("blockReason", () => {
  it("names what was found, so an admin can judge the block", () => {
    const scored = scoreProfile(
      flags({ intimate_offer: true, bio_external_cta: true }),
      signals({ hasPersonalChat: true })
    );
    const reason = blockReason({
      user_id: 1,
      verdict: scored.verdict,
      score: scored.score,
      signals: scored.signals,
      reasons: scored.reasons,
      profile: {
        first_name: "Анна",
        username: null,
        bio: null,
        personal_chat: null,
        rating_level: null,
        photo_unique_id: null,
      },
      flags: null,
      checked_at: new Date(),
      recheck_after: new Date(),
      action_taken: true,
      admin_cleared: false,
      cleared_by: null,
    });

    expect(reason).toContain("предложение интимного контента");
    expect(reason).toContain("уводит в личку");
    expect(reason).toContain("администратору");
  });
});
