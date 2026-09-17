import type { Collection, Db } from "mongodb";
import { classifyMessageJev, isJevConfigured } from "./jevClassifier.ts";

// Shadow mode: the production decision still comes from the OpenAI classifier.
// Jev is asked the same question on the side, and we only log how it compares.

type ShadowDoc = {
  createdAt: Date;
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
  production: boolean;
  jev: boolean;
  noul: number;
  kind: string;
  kindConfidence: number;
  agree: boolean;
  model: string;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number };
};

let shadowLog: Collection<ShadowDoc> | null = null;

export function initSpamShadow(db: Db) {
  shadowLog = db.collection<ShadowDoc>("jev_shadow");
}

export type ShadowInput = {
  text: string;
  chatId: number;
  userId: number;
  messageId: number;
  production: boolean;
};

/**
 * Runs Jev alongside the production classifier and logs the comparison.
 * Never throws and never affects the production decision — call without await.
 */
export function logSpamShadow(input: ShadowInput): void {
  if (!isJevConfigured()) return;

  classifyMessageJev(input.text)
    .then(async (verdict) => {
      const agree = verdict.spam === input.production;

      console.log(
        JSON.stringify({
          event: "jev_shadow",
          chatId: input.chatId,
          userId: input.userId,
          messageId: input.messageId,
          production: input.production,
          jev: verdict.spam,
          agree,
          noul: verdict.noul,
          kind: verdict.kind,
          kindConfidence: verdict.kindConfidence,
          model: verdict.model,
          latencyMs: verdict.latencyMs,
          usage: verdict.usage,
          text: input.text.slice(0, 500),
        })
      );

      if (!shadowLog) return;
      await shadowLog.insertOne({
        createdAt: new Date(),
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.messageId,
        text: input.text,
        production: input.production,
        jev: verdict.spam,
        noul: verdict.noul,
        kind: verdict.kind,
        kindConfidence: verdict.kindConfidence,
        agree,
        model: verdict.model,
        latencyMs: verdict.latencyMs,
        usage: verdict.usage,
      });
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "jev_shadow_error",
          chatId: input.chatId,
          messageId: input.messageId,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    });
}
