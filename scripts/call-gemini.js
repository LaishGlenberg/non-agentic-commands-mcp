import { GoogleGenAI } from "@google/genai";
import 'dotenv/config';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function callModel({
  prompt="When was chalk invented?", 
  model_id="gemini-3.1-flash-lite", 
  tools=[{ type: "google_search" }],
  persist_session=true
}) {
  const interaction = await ai.interactions.create({
    input: prompt,
    model: model_id,
    tools: tools,
    store: persist_session,
    generation_config: {
      thinking_level: "minimal"
    }
  });
  console.log(interaction.output_text);
}

callModel({prompt: "where can I find updated documentation on pi agent packages?"});
