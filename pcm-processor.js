// pcm-processor.js – AudioWorkletProcessor für PCM-16 Capture
// Ersetzt den deprecated ScriptProcessorNode

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._chunkSize = 4096; // 4096 Samples bei 16kHz = 256ms Chunks
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // Samples in Buffer akkumulieren
    const newBuffer = new Float32Array(this._buffer.length + channelData.length);
    newBuffer.set(this._buffer);
    newBuffer.set(channelData, this._buffer.length);
    this._buffer = newBuffer;

    // Wenn genug Samples: als PCM-16 Chunk senden
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this._buffer = this._buffer.slice(this._chunkSize);

      // Float32 → PCM16
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage({ pcm16: pcm16.buffer }, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
