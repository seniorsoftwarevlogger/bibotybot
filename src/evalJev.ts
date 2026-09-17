import { classifyMessageJev, isJevConfigured, SPAM_THRESHOLD } from "./jevClassifier.ts";

// Labelled set for tuning the Jev prompt: run `npm run jev:eval` after changing
// it. Not part of `npm test` — it costs API calls. `spam: true` means the
// message must be removed. The "ham" half deliberately includes messages that
// look like spam (asking about VPN, offering to pay for help, selling own
// hardware) because that is where a broader prompt starts to overreach.
export const CASES: { text: string; spam: boolean; note?: string }[] = [
  { text: "10 000 ЗА ПАРУ ЧАСОВ РАБОТЫ! БЕЗ ВЛОЖЕНИЙ! НИЧЕГО СЛОЖНОГО, СПРАВИТСЯ КАЖДЫЙ, ПИШИ МНЕ - ВСЁ РАССКАЖУ", spam: true },
  { text: "Бесплатный ВПН советую! ❤️", spam: true },
  { text: "у пацана в чате скинули способ, премиум в тг бесплатно активируется, у меня уже 4 месяца работает", spam: true },
  { text: "не думал что реально сработает - премиум в тг активируется без оплаты, звёздочка уже 4 месяца", spam: true },
  { text: "Ищy людeй желaющих хорoшо зaрабатывaть в удалeнном фopмате. Зa подрoбностями пишитe в личныe соoбщeния.", spam: true },
  { text: "хочешь ᴍои нюдcы и ʙидocы кaк меʜя иᴍeют ? подпиcывайcя тогда 🔥", spam: true },
  { text: "Готов купить ЮСДС tRc20. Гибко по времени. Беру крупно, мелочь не интересует.", spam: true },
  { text: "Добрый день, сотрудничаю с автошколой, есть возможность помочь со сдачей и документами. Получение только при личной встрече, все подробности в личных сообщениях!", spam: true },
  { text: "Нужно покрасить забор, кто хочет может помочь, Сколько сделаете столько и дам(300-3000)", spam: true },
  { text: "чек", spam: false },
  { text: "кто-нибудь пробовал bun вместо node на проде?", spam: false },
  { text: "vpn какой сейчас норм работает? amnezia ещё живая?", spam: false, note: "спрашивает про VPN" },
  { text: "бесплатный курс по алгоритмам на степике от мфти, реально полезный, рекомендую", spam: false, note: "советует бесплатное, но легальное" },
  { text: "я за месяц на фрилансе поднял 200к, но выгорел напрочь", spam: false, note: "деньги и работа" },
  { text: "ищу работу бэкендером, есть кто нанимает? резюме в профиле", spam: false, note: "ищет работу сам" },
  { text: "кто может помочь с деплоем? заплачу за час консультации, пишите в лс", spam: false, note: "деньги + в лс" },
  { text: "вот статья про это https://habr.com/ru/articles/123456/", spam: false },
  { text: "продам свой старый монитор, 10к, самовывоз спб", spam: false, note: "личная продажа" },
  { text: "залетайте на стрим, начинаем через 10 минут", spam: false, note: "анонс автора чата" },
  { text: "да ну бред какой-то, я за такое платить не буду", spam: false },
  { text: "поставил себе телеграм премиум, стикеры топ", spam: false, note: "премиум упомянут легально" },
];

if (!isJevConfigured()) {
  console.error("TYPESAFE_API_KEY is not set");
  process.exit(1);
}

const results = await Promise.all(
  CASES.map(async (c) => ({ ...c, verdict: await classifyMessageJev(c.text) }))
);

let missed = 0;
let falsePositives = 0;

for (const { text, spam, note, verdict } of results) {
  const ok = verdict.spam === spam;
  if (!ok && spam) missed++;
  if (!ok && !spam) falsePositives++;

  console.log(
    [
      ok ? "  " : "!!",
      spam ? "spam" : "ham ",
      `noul=${verdict.noul.toFixed(2)}`,
      `${verdict.kind}(${verdict.kindConfidence.toFixed(2)})`.padEnd(24),
      text.slice(0, 58),
      note ? `<- ${note}` : "",
    ].join(" ")
  );
}

const spamNouls = results.filter((r) => r.spam).map((r) => r.verdict.noul);
const hamNouls = results.filter((r) => !r.spam).map((r) => r.verdict.noul);

console.log(
  `\nthreshold ${SPAM_THRESHOLD}: ${missed} missed spam, ${falsePositives} false positives of ${CASES.length}`
);
console.log(
  `weakest spam ${Math.min(...spamNouls).toFixed(2)}, strongest ham ${Math.max(...hamNouls).toFixed(2)}`
);

process.exit(missed + falsePositives === 0 ? 0 : 1);
