// Whisper 음성 인식을 UI와 분리된 워커에서 돌린다. 모델은 처음 한 번 내려받아 캐시에 둔다.
import { pipeline, env } from '../../node_modules/@huggingface/transformers/dist/transformers.js';

const MODEL = 'onnx-community/whisper-small';

env.allowLocalModels = false;
// onnxruntime의 wasm 파일을 CDN이 아닌 로컬 node_modules에서 불러온다
env.backends.onnx.wasm.wasmPaths = new URL('../../node_modules/@huggingface/transformers/dist/', import.meta.url).href;

let transcriber = null;

async function load() {
  transcriber ??= await pipeline('automatic-speech-recognition', MODEL, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
    },
  });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      self.postMessage({ type: 'ready', threads: env.backends.onnx.wasm.numThreads, isolated: self.crossOriginIsolated });
    } else if (data.type === 'transcribe') {
      await load();
      const output = await transcriber(data.audio, { language: data.language, task: 'transcribe' });
      self.postMessage({ type: 'result', id: data.id, text: output.text });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message ?? err) });
  }
};
