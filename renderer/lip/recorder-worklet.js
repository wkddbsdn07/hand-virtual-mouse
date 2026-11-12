// 마이크 입력을 512샘플(16kHz 기준 32ms)씩 모아 메인 스레드로 보낸다
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(512);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) {
        this.buffer[this.length++] = sample;
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer.slice());
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', Recorder);
