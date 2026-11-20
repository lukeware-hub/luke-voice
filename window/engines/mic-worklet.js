// Runs on the audio thread: hands the page the mic audio in 512-sample frames.
// The AudioContext runs at 16 kHz, so Chrome resamples the mic before it gets here.
class MicFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(512)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let read = 0
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.frame.length - this.filled)
      this.frame.set(channel.subarray(read, read + take), this.filled)
      this.filled += take
      read += take
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer])
        this.frame = new Float32Array(512)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('luke-mic-frames', MicFrames)
