import OpenAI from 'openai';
import process from 'node:process';
import 'dotenv/config';
// Initialize the OpenAI client with OpenCode Go configurations
const openai = new OpenAI({
  baseURL: 'https://opencode.ai/zen/go/v1', 
  apiKey: process.env.OPENCODE_API_KEY, 
});

async function main() {
  try {
    const response = await openai.chat.completions.create({
      model: 'mimo-v2.5', // Specify your target OpenCode model
      messages: [
        { role: 'user', content: 'say hello' },
      ],
      //temperature: 0.7,
    });

    console.log('Response:', response.choices[0].message.content);
  } catch (error) {
    console.error('API Error:', error);
  }
}

main();
