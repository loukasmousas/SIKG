import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadModel } from 'gpt4all';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const MODEL_DIR = process.env.MODELS_DIR || 'models';
const MODEL_NAME =
  process.env.LLM_MODEL || 'mistral-7b-instruct-v0_1.Q4_0.gguf';
const MODEL_LIST = path.join(MODEL_DIR, 'models.simple.json');

async function ensureModelList(modelName) {
  const abs = path.join(root, MODEL_LIST);
  try {
    await fs.access(abs);
  } catch {
    const arr = [{ filename: modelName }];
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(arr, null, 2), 'utf8');
  }
}

async function main() {
  const npred = Number(process.env.LLM_NPREDICT || 64);
  await ensureModelList(MODEL_NAME);
  console.log('[llm-smoke] Using model:', MODEL_NAME, 'dir:', MODEL_DIR);
  const model = await loadModel(MODEL_NAME, {
    modelPath: MODEL_DIR,
    modelConfigFile: MODEL_LIST,
    allowDownload: false,
    verbose: true,
    device: 'cpu',
    nCtx: 1024,
  });

  const FEW_SHOT = `You are an assistant that outputs only valid SPARQL 1.1 queries, nothing else.\n\nPREFIX ex: <http://example.org/>\nQ: "show every person"\nA: PREFIX ex: <http://example.org/>\n  SELECT ?r WHERE { ?r a ex:person }\n`;
  const question = 'find every person';
  const prompt = `${FEW_SHOT}\nQ: "${question}"\nA:`;
  console.log('[llm-smoke] Generating...');
  const out = await model.generate(prompt, {
    temp: Number(process.env.LLM_TEMP || 0.2),
    nPredict: npred,
    stop: ['\nQ:', '\n\n', '</s>', '```'],
  });
  const text = typeof out === 'string' ? out : out?.text || out?.output || '';
  console.log('\n[llm-smoke] Output:\n', (text || '').slice(0, 400));
}

main().catch((e) => {
  console.error('[llm-smoke] Error:', e.message);
  process.exit(1);
});
