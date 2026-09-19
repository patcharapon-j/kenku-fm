/**
 * Master bus processor for the capture window
 *
 * Everything leaving the window passes through here. It limits the mix, hands
 * the limited signal back on its output for local monitoring, and posts the
 * same audio to the renderer in blocks so that it can be encoded.
 *
 * Audio is posted as planar 32bit float (the left channel followed by the
 * right) rather than interleaved 16bit, as that is the layout the Opus encoder
 * wants and it avoids a quantisation step that the encoder would only have to
 * undo. The blocks are transferred rather than copied, and the renderer
 * transfers the memory back once it is done with it, so a steady stream does
 * not allocate at all.
 */

/** Sample value the limiter holds the mix below, -1dBFS */
const DEFAULT_CEILING = 0.891;
/** Most buffers to keep for reuse before letting the extras be collected */
const MAX_POOLED_BUFFERS = 8;

/**
 * Lookahead peak limiter
 *
 * The mix is delayed by the lookahead while the gain is computed from the
 * audio that has not been heard yet, so the gain is already where it needs to
 * be by the time a peak reaches the output. That is what separates this from
 * the compressor it replaces, which could only start reacting once a peak had
 * already been let through.
 */
class Limiter {
  constructor(lookahead, ceiling, releaseSamples) {
    // One slot more than the lookahead: the sample leaving the delay line and
    // the sample entering it are both inside the window the gain is taken
    // from, so they cannot share a slot
    const size = lookahead + 1;
    this._size = size;
    this._ceiling = ceiling;
    this._delayLeft = new Float32Array(size);
    this._delayRight = new Float32Array(size);
    /** Gain each buffered sample would need on its own to stay under the ceiling */
    this._gains = new Float32Array(size);
    this._gains.fill(1);
    /**
     * Indices into `_gains` of the samples still in the window, ordered so that
     * their gains increase from the front. The front is therefore the smallest
     * gain in the window, which is the gain the output has to reach. Keeping
     * the indices ordered is what makes that minimum O(1) per sample rather
     * than a scan of the whole window
     */
    this._queue = new Int32Array(size);
    this._queueHead = 0;
    this._queueLength = 0;
    this._write = 0;
    /** Gain currently being applied, moved towards the target sample by sample */
    this._gain = 1;
    // Covering the whole gain range within the lookahead is what guarantees the
    // target is reached before the peak it was computed for arrives
    this._attackStep = 1 / lookahead;
    this._releaseStep = 1 / releaseSamples;
    /** Lowest gain applied since the metering was last read */
    this.minGain = 1;
    /** Highest sample seen on the way in since the metering was last read */
    this.inputPeak = 0;
  }

  /**
   * Limit one stereo sample and write the result into the given output arrays
   * The sample written out is the one that entered `lookahead` samples ago
   */
  process(left, right, out, index) {
    const size = this._size;
    const write = this._write;

    // The slot about to be reused holds the oldest sample in the window, so
    // its gain leaves the window before the new one is added
    if (this._queueLength > 0 && this._queue[this._queueHead] === write) {
      this._queueHead = (this._queueHead + 1) % size;
      this._queueLength--;
    }

    const peak = Math.max(Math.abs(left), Math.abs(right));
    if (peak > this.inputPeak) {
      this.inputPeak = peak;
    }
    const required = peak > this._ceiling ? this._ceiling / peak : 1;

    this._delayLeft[write] = left;
    this._delayRight[write] = right;
    this._gains[write] = required;
    // Anything at the back of the queue with a gain this sample already covers
    // can never be the minimum again, so it is dropped rather than tracked
    while (
      this._queueLength > 0 &&
      this._gains[this._queue[(this._queueHead + this._queueLength - 1) % size]] >=
        required
    ) {
      this._queueLength--;
    }
    this._queue[(this._queueHead + this._queueLength) % size] = write;
    this._queueLength++;

    const read = (write + 1) % size;
    const target = this._gains[this._queue[this._queueHead]];
    if (target < this._gain) {
      this._gain = Math.max(target, this._gain - this._attackStep);
    } else if (target > this._gain) {
      this._gain = Math.min(target, this._gain + this._releaseStep);
    }
    if (this._gain < this.minGain) {
      this.minGain = this._gain;
    }

    out[0][index] = this._delayLeft[read] * this._gain;
    out[1][index] = this._delayRight[read] * this._gain;

    this._write = read;
  }

  /** Start the peak and gain reduction metering over again */
  resetMetering() {
    this.minGain = 1;
    this.inputPeak = 0;
  }
}

class PCMStream extends AudioWorkletProcessor {
  constructor(config) {
    super(config);
    const options = config.processorOptions || {};
    /** Samples per channel in each block posted to the renderer */
    this._framesPerBlock = options.framesPerBlock;
    this._limiter = new Limiter(
      options.lookahead,
      options.ceiling || DEFAULT_CEILING,
      options.releaseSamples,
    );
    /** Block being filled, in planar layout: the left channel then the right */
    this._block = new Float32Array(this._framesPerBlock * 2);
    /** Number of samples per channel written into the current block */
    this._offset = 0;
    /** Blocks the renderer has handed back, ready to be filled again */
    this._pool = [];
    /** Highest sample posted on each channel since the last block */
    this._peakLeft = 0;
    this._peakRight = 0;
    // The renderer transfers each block's memory back once it has encoded it,
    // which is what keeps a steady stream from allocating
    this.port.onmessage = (event) => {
      const returned = event.data;
      if (
        returned instanceof ArrayBuffer &&
        this._pool.length < MAX_POOLED_BUFFERS
      ) {
        this._pool.push(new Float32Array(returned));
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    // A disconnected input has no channels at all, anything with at least one
    // is made stereo so that the stream we send stays stereo instead of
    // falling silent. Anything wider than stereo uses its first two channels
    const hasInput = input && input.length >= 1;
    const left = hasInput ? input[0] : undefined;
    const right = hasInput ? (input.length > 1 ? input[1] : input[0]) : undefined;
    // The node is created asking for stereo out, so a quantum without both
    // channels means the graph is in a state this can't write into and the
    // block is left for the next one rather than throwing, which would stop
    // the processor for the rest of the session
    if (!output || output.length < 2) {
      return true;
    }
    // `process` is called with a fixed length render quantum, which the output
    // always has even when nothing is connected to the input
    const length = output[0].length;

    for (let i = 0; i < length; i++) {
      // A missing input is passed on as silence rather than skipped: the
      // broadcast is a continuous stream, so a gap in it stalls the encoder
      // instead of being heard as a moment of quiet
      this._limiter.process(
        left ? left[i] : 0,
        right ? right[i] : 0,
        output,
        i,
      );
    }

    this._bufferBlock(output[0], output[1], length);

    return true;
  }

  /** Add a render quantum of limited audio to the block being filled */
  _bufferBlock(left, right, length) {
    const frames = this._framesPerBlock;
    let read = 0;
    while (read < length) {
      const room = frames - this._offset;
      const count = Math.min(room, length - read);
      const offset = this._offset;
      for (let i = 0; i < count; i++) {
        const l = left[read + i];
        const r = right[read + i];
        this._block[offset + i] = l;
        this._block[frames + offset + i] = r;
        const peakLeft = l < 0 ? -l : l;
        const peakRight = r < 0 ? -r : r;
        if (peakLeft > this._peakLeft) {
          this._peakLeft = peakLeft;
        }
        if (peakRight > this._peakRight) {
          this._peakRight = peakRight;
        }
      }
      this._offset += count;
      read += count;
      if (this._offset === frames) {
        this._postBlock();
      }
    }
  }

  /** Hand the filled block to the renderer and take a fresh one */
  _postBlock() {
    const block = this._block;
    const limiter = this._limiter;
    this.port.postMessage(
      {
        audio: block,
        peakLeft: this._peakLeft,
        peakRight: this._peakRight,
        // The limiter holds the output under the ceiling, so an over is only
        // ever visible on the way in. That is what tells a user a source is
        // too hot rather than that the limiter is doing its job
        clipped: limiter.inputPeak > 1,
        reduction: limiter.minGain,
      },
      [block.buffer],
    );
    limiter.resetMetering();
    this._peakLeft = 0;
    this._peakRight = 0;
    this._offset = 0;
    this._block =
      this._pool.pop() || new Float32Array(this._framesPerBlock * 2);
  }
}

registerProcessor("pcm-stream", PCMStream);
