import { GoogleGenAI } from "@google/genai";
import 'dotenv/config';
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function main() {
  const rl = createInterface({ input, output });

  console.log("\n🤖 Gemini Terminal Chat (Interactions API)");
  console.log("Type your messages below. Type 'exit' to quit.\n");

  let previousInteractionId = null;

  while (true) {
    const userInput = await rl.question("You: ");

    if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("Goodbye!");
      break;
    }

    if (!userInput.trim()) continue;

    try {
      const interaction = await ai.interactions.create({
        model: "gemini-3.1-flash-lite",
        input: userInput,
        ...(previousInteractionId && { previous_interaction_id: previousInteractionId }),
        tools: [{ type: "google_search" }]
      });

      console.log(`Assistant: ${interaction.output_text}\n`);
      previousInteractionId = interaction.id;
    } catch (error) {
      console.error("Error:", error.message);
    }
  }

  rl.close();
}

main();