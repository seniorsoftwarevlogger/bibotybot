import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const {
  TYPESAFE_API_KEY = "",
  JEV_MODEL = "jev-latest",
  JEV_SPAM_THRESHOLD = "0.35",
  JEV_TIMEOUT_MS = "5000",
} = process.env;

export const SPAM_THRESHOLD = Number(JEV_SPAM_THRESHOLD);
const TIMEOUT_MS = Number(JEV_TIMEOUT_MS);

// Client reads TYPESAFE_API_KEY itself, but the constructor throws when the key
// is missing, so keep it lazy and let the caller see a null classifier instead.
const client = TYPESAFE_API_KEY
  ? new TypeSafeClient({ apiKey: TYPESAFE_API_KEY, defaultModel: JEV_MODEL })
  : null;

export const isJevConfigured = () => client !== null;

const SPAM_KINDS = {
  job_scam: "Предложение лёгкого заработка, подработки, «сотрудничества», набор в команду, разовые поручения незнакомцам за наличные, приглашение написать в личные сообщения",
  freebie_bait: "Приманка с халявой: бесплатная активация платных сервисов (телеграм премиум, подписки), «бесплатный» VPN, накрутка, реферальные схемы и «способы», которые надо узнать у автора",
  crypto: "Реклама крипто-монет, аирдропов, розыгрышей, покупка или продажа USDT и другой криптовалюты",
  erotic: "Эротический спам, приглашение на приватный контент, нюдсы, ссылки на интимные каналы",
  illegal_services: "Продажа документов, помощь со сдачей экзаменов, обход правил, серые и незаконные услуги",
  other_spam: "Другая непрошеная реклама или рассылка",
  not_spam: "Обычное сообщение участника чата, не спам",
} as const;

const questions = {
  is_spam: noul(
    "Это сообщение из публичного чата про разработку и IT. Является ли оно спамом: непрошеное предложение заработка или подработки, вовлечение в сомнительное «сотрудничество», реклама крипто-монет, покупка или продажа USDT, эротический спам, серые услуги, а также приманки — бесплатная активация платных сервисов (телеграм премиум, подписки), «бесплатный» VPN, накрутка, реферальные схемы и «способы», за которыми надо идти к автору. Сообщение может быть на любом языке и содержать похожие по виду символы вместо обычных букв.",
    {
      true: "Человек продвигает что-то не по теме чата или втягивает в схему: обещает доход, зовёт в личные сообщения за «способом», рекламирует бесплатный доступ к платным сервисам, крипту, интимный контент, серые услуги. Считается и мягкая форма от первого лица — «у меня уже работает», «советую», «скинули способ» — и разовые поручения незнакомцам за наличные",
      false: "Живое сообщение участника по теме чата: вопрос, мнение, шутка, жалоба, ссылка на статью, рассказ о своём опыте, поиск работы для себя, просьба помочь с задачей. Упоминание денег, VPN или телеграм премиума само по себе спамом не делает",
    }
  ),
  spam_kind: choice("К какой категории относится сообщение?", SPAM_KINDS),
} as const;

export type JevVerdict = {
  spam: boolean;
  noul: number;
  kind: keyof typeof SPAM_KINDS;
  kindProbabilities: Readonly<Record<keyof typeof SPAM_KINDS, number>>;
  kindConfidence: number;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
};

export async function classifyMessageJev(message: string): Promise<JevVerdict> {
  if (!client) {
    throw new Error("jev: TYPESAFE_API_KEY is not set");
  }

  const startedAt = Date.now();
  const response = await client.systemOne(
    { state: message, questions },
    { timeout: TIMEOUT_MS }
  );
  const { is_spam, spam_kind } = response.answers;

  return {
    spam: is_spam.noul >= SPAM_THRESHOLD,
    noul: is_spam.noul,
    kind: spam_kind.choice,
    kindProbabilities: spam_kind.probabilities,
    kindConfidence: spam_kind.confidence,
    model: response.model,
    usage: response.usage,
    latencyMs: Date.now() - startedAt,
  };
}
