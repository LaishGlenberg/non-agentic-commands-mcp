import { OpenCodeClient } from '@opencode-ai/sdk';
import process from 'node:process';

// Initializes using process.env.OPENCODE_API_KEY by default
const client = new OpenCodeClient({
  apiKey: process.env.OPENCODE_API_KEY
});

async function main() {
  const runner = await client.agent.createSession({
    // Use the provider prefix to route to the Go subscription line
    provider: 'opencode-go',
    model: 'qwen3.5-plus', 
    messages: [
      { role: 'user', content: 'Design a clean Next.js API route architecture.' }
    ]
  });

  console.log('Result:', runner.choices[0].message.content);
}

main();