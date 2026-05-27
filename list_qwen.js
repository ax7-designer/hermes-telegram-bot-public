const fetch = require('node-fetch'); // wait, node-fetch might not be installed, but node v24 has global fetch!
// Let's use global fetch (standard in modern Node.js v18+)
async function main() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const json = await res.json();
    const qwenModels = json.data
      .filter(m => m.id.toLowerCase().includes("qwen"))
      .map(m => ({ id: m.id, name: m.name }));
    console.log(JSON.stringify(qwenModels, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}
main();
