import natural from "natural";
import readline from "readline";
import { classifyMessage } from "./classifier.ts";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

natural.BayesClassifier.load(
  "./classifier.json",
  natural.PorterStemmerRu,
  (err, classifier) => {
    if (err) {
      console.error("Error loading the classifier:", err);
      process.exit(1);
    }

    console.log(
      "Classifier loaded. Enter a message to classify (or 'exit' to quit):"
    );

    rl.on("line", (input) => {
      if (input.toLowerCase() === "exit") {
        rl.close();
        return;
      }

      const result = classifyMessage(input, classifier);
      console.log(`Classification: ${result}`);
      console.log("Enter another message (or 'exit' to quit):");
    });

    rl.on("close", () => {
      console.log("Goodbye!");
      process.exit(0);
    });
  }
);
