class CmajorOutputMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameCount = 0;
    this.minimum = [];
    this.maximum = [];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frameCount = output[0]?.length || input[0]?.length || 0;

    for (let channel = 0; channel < output.length; ++channel) {
      const source = input[channel] || input[0];
      if (source) output[channel].set(source);
      else output[channel].fill(0);
    }

    for (let frame = 0; frame < frameCount; ++frame) {
      for (let channel = 0; channel < input.length; ++channel) {
        const sample = input[channel][frame];
        if (this.frameCount === 0) {
          this.minimum[channel] = sample;
          this.maximum[channel] = sample;
        } else {
          this.minimum[channel] = Math.min(this.minimum[channel], sample);
          this.maximum[channel] = Math.max(this.maximum[channel], sample);
        }
      }

      if (++this.frameCount === 400) {
        this.frameCount = 0;
        this.port.postMessage({ min: this.minimum.slice(), max: this.maximum.slice() });
      }
    }

    return true;
  }
}

registerProcessor("cmajor-output-meter", CmajorOutputMeterProcessor);
