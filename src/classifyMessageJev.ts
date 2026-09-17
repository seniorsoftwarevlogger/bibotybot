import { classifyMessageJev, isJevConfigured, SPAM_THRESHOLD } from "./jevClassifier.ts";

// Usage: npm run jev -- "текст сообщения"
const message = process.argv.slice(2).join(" ");

if (!message) {
  console.error('Usage: npm run jev -- "текст сообщения"');
  process.exit(1);
}

if (!isJevConfigured()) {
  console.error("TYPESAFE_API_KEY is not set");
  process.exit(1);
}

const verdict = await classifyMessageJev(message);
console.log(JSON.stringify({ threshold: SPAM_THRESHOLD, ...verdict }, null, 2));
