import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

// The fuzzy half of the account check: read a profile's bio and avatar the way
// a human moderator would. Homoglyph-obfuscated bios ("Ищy людeй желaющих…") are
// exactly what regular expressions miss, so the reading is delegated to the
// model. The decision to block is NOT made here — profileGate.ts combines these
// flags with Telegram's own signals and requires two independent ones.
//
// Sex and attractiveness are not signals on their own: a woman's name and a
// pretty photo say nothing, selling intimate content does. The prompt says so
// explicitly, and no flag below mentions gender.

export const PROFILE_MODEL = "gpt-4o-mini";

// detail:"low" costs ~2.9k prompt tokens for a 640x640 avatar; the default
// (high) costs ~25.5k — nine times more for no gain on a classification task.
const AVATAR_DETAIL = "low";
const REQUEST_TIMEOUT_MS = 15_000;

let _openai: OpenAI | null = null;
function defaultClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export type ProfileInput = {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  bio?: string | null;
  personalChat?: { title?: string | null; username?: string | null } | null;
  avatarBase64?: string | null;
};

export type ProfileFlags = {
  intimate_offer: boolean;
  seductive_avatar: boolean;
  stock_or_ai_avatar: boolean;
  bio_external_cta: boolean;
  bio_earnings_or_crypto: boolean;
  looks_like_real_person: boolean;
  confidence: number;
  // The model declined to describe the avatar, which in practice means it found
  // explicit content in it. A signal, never a sole reason to block.
  refused: boolean;
  model: string;
  tokens: { input: number; output: number };
  latencyMs: number;
};

const FLAG_DESCRIPTIONS: Record<string, string> = {
  intimate_offer:
    "профиль продаёт или предлагает интимный контент: нюдсы, 18+, «продолжение в личке», onlyfans, знакомства с продолжением",
  seductive_avatar:
    "аватар — откровенное или нарочито соблазняющее фото, подающее человека как товар; обычное красивое фото этим не является",
  stock_or_ai_avatar:
    "аватар похож на стоковый, сгенерированный нейросетью или рекламный кадр: идеальная ретушь, студийный свет, водяной знак, неестественные детали лица или рук",
  bio_external_cta:
    "bio, имя или личный канал уводят наружу: ссылка, чужой ник, «пиши в лс», onlyfans/instagram/whatsapp",
  bio_earnings_or_crypto:
    "bio предлагает заработок, партнёрку, криптовалюту, ставки, инвестиции или «схему»",
  looks_like_real_person:
    "признаки живого человека: бытовое или семейное фото, обычное имя, bio о себе без рекламы и без призывов",
};

const FLAGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    ...Object.keys(FLAG_DESCRIPTIONS),
    "confidence",
  ],
  properties: {
    ...Object.fromEntries(
      Object.keys(FLAG_DESCRIPTIONS).map((flag) => [flag, { type: "boolean" }])
    ),
    confidence: { type: "number" },
  },
} as const;

export function profilePrompt(input: ProfileInput): string {
  const lines = [
    "Ты — модератор Telegram-чата. Ниже данные профиля аккаунта" +
      (input.avatarBase64 ? " и его аватар." : "."),
    "",
    `Имя: ${[input.firstName, input.lastName].filter(Boolean).join(" ") || "(нет)"}`,
    `Username: ${input.username ? `@${input.username}` : "(нет)"}`,
    `Bio: ${input.bio ?? "(нет)"}`,
    input.personalChat
      ? `Личный канал: ${input.personalChat.title ?? "(без названия)"} ${
          input.personalChat.username ? `@${input.personalChat.username}` : ""
        }`.trimEnd()
      : "Личный канал: (нет)",
    "",
    "Определи признаки массового спамерского аккаунта. Пол, возраст и привлекательность человека признаками НЕ являются — важны только продажа контента, реклама и накрутка.",
    "",
    ...Object.entries(FLAG_DESCRIPTIONS).map(([flag, what]) => `- ${flag}: ${what}`),
    "- confidence: 0..1, насколько ты уверен в ответах",
    "",
    "Если данных мало, ставь false и низкую confidence: домысливать нельзя.",
  ];
  return lines.join("\n");
}

function refusedFlags(latencyMs: number): ProfileFlags {
  return {
    intimate_offer: false,
    seductive_avatar: false,
    stock_or_ai_avatar: false,
    bio_external_cta: false,
    bio_earnings_or_crypto: false,
    looks_like_real_person: false,
    confidence: 0.5,
    refused: true,
    model: PROFILE_MODEL,
    tokens: { input: 0, output: 0 },
    latencyMs,
  };
}

// OpenAI rejects an explicit image with a 400 content-policy error instead of
// answering the schema; that rejection is itself information about the avatar.
function isContentPolicyRefusal(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string };
  if (candidate?.code === "content_policy_violation") return true;
  return (
    candidate?.status === 400 &&
    /content policy|content_policy|safety|inappropriate|sexually explicit/i.test(
      candidate?.message ?? ""
    )
  );
}

/**
 * Returns null when the model could not be asked at all (network, timeout,
 * quota). The caller treats null as "no opinion" and scores the account from
 * Telegram's signals only, so an OpenAI outage can never block anybody.
 */
export async function classifyProfileOpenAI(
  input: ProfileInput,
  client: OpenAI = defaultClient()
): Promise<ProfileFlags | null> {
  const startedAt = Date.now();
  const text = profilePrompt(input);
  const content = input.avatarBase64
    ? [
        { type: "text" as const, text },
        {
          type: "image_url" as const,
          image_url: {
            url: `data:image/jpeg;base64,${input.avatarBase64}`,
            detail: AVATAR_DETAIL,
          },
        },
      ]
    : text;

  try {
    const response = await client.chat.completions.create(
      {
        model: PROFILE_MODEL,
        messages: [{ role: "user", content }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "profile_flags", strict: true, schema: FLAGS_SCHEMA },
        },
        temperature: 0,
        max_tokens: 200,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return refusedFlags(Date.now() - startedAt);

    const parsed = JSON.parse(raw) as Partial<ProfileFlags>;
    return {
      intimate_offer: !!parsed.intimate_offer,
      seductive_avatar: !!parsed.seductive_avatar,
      stock_or_ai_avatar: !!parsed.stock_or_ai_avatar,
      bio_external_cta: !!parsed.bio_external_cta,
      bio_earnings_or_crypto: !!parsed.bio_earnings_or_crypto,
      looks_like_real_person: !!parsed.looks_like_real_person,
      confidence: Number(parsed.confidence ?? 0),
      refused: false,
      model: response.model ?? PROFILE_MODEL,
      tokens: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (isContentPolicyRefusal(error)) {
      return refusedFlags(Date.now() - startedAt);
    }
    console.error("profileClassifier: OpenAI call failed:", error);
    return null;
  }
}
