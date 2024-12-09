import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const spamExamples = [
  "Ищy людeй желaющих хорoшо зaрабатывaть в удалeнном фopмате. Зa подрoбностями пишитe в личныe соoбщeния.",
  "Eсли у тебя eсть 30 минут cвободных в дeнь и жeлание зaрабатывать. Тoгда ждy в ЛC. Oт 300$ в дeнь.",
  "3дpaвcтвyйтe, ищy пapтнёров для coтрyдничествa. Cвoбoдный гpaфик👌 Пpиятный 3apaбoтoк oт 200$ в дeнь Ecли интepecуeт пoдpoбнaя инфopмaция " +
    " в личные сooбщения",
  "Набираю команду для партнерства на зваимовыгодной основе. Ежедневная прибыль на пасиве. Жду в личных сообщениях.",
  "Дoбрый дeнь! Ищeм людeй для сoдрудничества  oт 21 гoда. Ежeдневный дoход от 600 длр. Пишите + в личные смс кто заинтересован.",
  "хочешь ᴍои нюдcы и ʙидocы кaк меʜя иᴍeют ? подпиcывайcя тогда 🔥",
  "зᴀшёл бы ктᴏ ʙ меня 😄",
  "хочешь меня?"
];

export async function classifyMessageOpenAI(message: string): Promise<boolean> {
  const prompt = `
Определи, является ли следующее сообщение эротическим спамом или вовлечением в сомнительные предложения о сотрудничестве. Учитывай следующие примеры спам-сообщений:

${spamExamples.map((example) => `- ${example}`).join("\n")}

Сообщение для классификации:
"${message}"

Является ли это сообщение спамом? Ответь только "да" или "нет".
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Ты — эксперт по спаму. Ты отвечаешь только 'да' или 'нет'.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 1,
      n: 1,
      stop: null,
      temperature: 0.5,
    });

    const answer = response.choices[0].message.content?.trim().toLowerCase();
    return answer === "да";
  } catch (error) {
    console.error("Error classifying message with OpenAI:", error);
    return false;
  }
}
