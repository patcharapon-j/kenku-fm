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
 * K-weighting filter coefficients from ITU-R BS.1770-4, at 48KHz
 *
 * The weighting is what makes the measurement match what a listener hears
 * rather than what a peak meter reads: a high shelf standing in for the head's
 * response, then a high pass that stops low frequency energy dominating.
 *
 * These are the rate the capture context asks for and gets in all but odd
 * cases, which are warned about separately. At another rate the curve is
 * slightly off, which moves the measurement by a fraction of a dB rather than
 * breaking it
 */
const K_SHELF = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const K_HIGHPASS = {
  b0: 1.0,
  b1: -2.0,
  b2: 1.0,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};
/** Offset that turns the weighted mean square into LUFS, from BS.1770 */
const LUFS_OFFSET = -0.691;
/**
 * Loudness below which a block is treated as silence
 *
 * This is the absolute gate from the standard, and it is applied per block
 * rather than to the window as a whole. That distinction matters: a window
 * that is part music and part silence would otherwise measure the average of
 * the two and wind the gain up through every gap between tracks, only to stop
 * once the gap was total. Dropping the silent blocks instead means the window
 * measures the music that is in it, however little of it there is
 */
const GATE_LUFS = -70;
/** Duration in seconds of each block the loudness is accumulated over */
const LOUDNESS_BLOCK = 0.1;
/** Number of those blocks the measurement looks back over */
const LOUDNESS_BLOCKS = 30;
/**
 * How much of the window has to be music before the gain is re-aimed
 *
 * As a track ends, the window empties a block at a time, and the last one or
 * two left in it are the quietest part of the fade. Those are still above the
 * absolute gate, so without this the measurement would end up taken from a
 * fragment, read the mix as far quieter than it was, and wind the gain up
 * through the gap before the next track arrived to push it back down
 */
const MIN_ACTIVE_BLOCKS = 10;

/** One stage of the K-weighting filter */
class Biquad {
  constructor(coefficients) {
    this._c = coefficients;
    this._x1 = 0;
    this._x2 = 0;
    this._y1 = 0;
    this._y2 = 0;
  }

  process(x) {
    const c = this._c;
    const y =
      c.b0 * x +
      c.b1 * this._x1 +
      c.b2 * this._x2 -
      c.a1 * this._y1 -
      c.a2 * this._y2;
    this._x2 = this._x1;
    this._x1 = x;
    this._y2 = this._y1;
    this._y1 = y;
    return y;
  }
}

/**
 * Loudness normaliser
 *
 * Sources reach the master bus at wildly different levels: a mastered track
 * from disk, a video in a tab and a soundboard hit have no reason to agree.
 * This measures how loud the mix actually sounds, to the same standard
 * streaming services normalise to, and moves a gain towards a target.
 *
 * The measurement is taken before the gain is applied, so the gain is never
 * chasing its own output. It moves slowly, and much more slowly upwards than
 * downwards, because a normaliser that reacts quickly is just a compressor
 * that pumps. Whatever it does, the limiter after it still holds the ceiling.
 */
class LoudnessNormalizer {
  constructor(sampleRate, options) {
    this._targetLufs = options.targetLufs;
    this._maxGain = Math.pow(10, options.maxGainDb / 20);
    this._minGain = Math.pow(10, options.minGainDb / 20);
    // A gain that moves by a fixed number of dB per second is a fixed
    // multiplier per sample, which keeps this to one multiply in the loop
    this._upStep = Math.pow(10, options.upDbPerSecond / (20 * sampleRate));
    this._downStep = Math.pow(10, -options.downDbPerSecond / (20 * sampleRate));
    this._shelfLeft = new Biquad(K_SHELF);
    this._shelfRight = new Biquad(K_SHELF);
    this._highpassLeft = new Biquad(K_HIGHPASS);
    this._highpassRight = new Biquad(K_HIGHPASS);
    this._blockSamples = Math.max(1, Math.round(sampleRate * LOUDNESS_BLOCK));
    this._blocksLeft = new Float64Array(LOUDNESS_BLOCKS);
    this._blocksRight = new Float64Array(LOUDNESS_BLOCKS);
    /** Which blocks in the window are silence, and so left out of the measure */
    this._blockGated = new Uint8Array(LOUDNESS_BLOCKS);
    this._blockGated.fill(1);
    this._blockIndex = 0;
    /** Number of blocks in the window that are loud enough to be measured */
    this._activeBlocks = 0;
    this._sumLeft = 0;
    this._sumRight = 0;
    this._accLeft = 0;
    this._accRight = 0;
    this._accCount = 0;
    this.enabled = false;
    this._targetGain = 1;
    this.gain = 1;
  }

  /** Measure one stereo sample and return the gain to apply to it */
  process(left, right) {
    // Nothing to measure and nothing to undo, so the whole filter chain is
    // skipped rather than run to produce a gain of one
    if (!this.enabled && this.gain === 1) {
      return 1;
    }
    if (this.enabled) {
      this._measure(left, right);
    }
    const target = this.enabled ? this._targetGain : 1;
    if (this.gain < target) {
      this.gain = Math.min(target, this.gain * this._upStep);
    } else if (this.gain > target) {
      this.gain = Math.max(target, this.gain * this._downStep);
    }
    return this.gain;
  }

  _measure(left, right) {
    const weightedLeft = this._highpassLeft.process(
      this._shelfLeft.process(left),
    );
    const weightedRight = this._highpassRight.process(
      this._shelfRight.process(right),
    );
    this._accLeft += weightedLeft * weightedLeft;
    this._accRight += weightedRight * weightedRight;
    this._accCount++;
    if (this._accCount < this._blockSamples) {
      return;
    }

    const meanLeft = this._accLeft / this._accCount;
    const meanRight = this._accRight / this._accCount;
    this._accLeft = 0;
    this._accRight = 0;
    this._accCount = 0;

    const blockMeanSquare = meanLeft + meanRight;
    const gated =
      blockMeanSquare <= 0 ||
      LUFS_OFFSET + 10 * Math.log10(blockMeanSquare) < GATE_LUFS;

    // The window is kept as a running total so that a block joining or leaving
    // it costs the same however far back the measurement looks
    const index = this._blockIndex;
    if (!this._blockGated[index]) {
      this._sumLeft -= this._blocksLeft[index];
      this._sumRight -= this._blocksRight[index];
      this._activeBlocks--;
    }
    this._blocksLeft[index] = meanLeft;
    this._blocksRight[index] = meanRight;
    this._blockGated[index] = gated ? 1 : 0;
    if (!gated) {
      this._sumLeft += meanLeft;
      this._sumRight += meanRight;
      this._activeBlocks++;
    }
    this._blockIndex = (index + 1) % LOUDNESS_BLOCKS;
    // A total kept by adding and subtracting drifts over a long session, so it
    // is rebuilt from the window each time the ring comes back around
    if (this._blockIndex === 0) {
      let left = 0;
      let right = 0;
      let active = 0;
      for (let i = 0; i < LOUDNESS_BLOCKS; i++) {
        if (this._blockGated[i]) {
          continue;
        }
        left += this._blocksLeft[i];
        right += this._blocksRight[i];
        active++;
      }
      this._sumLeft = left;
      this._sumRight = right;
      this._activeBlocks = active;
    }

    // Too little of the window is loud enough to say how loud the mix is, so
    // the gain holds where it is rather than chasing a fragment or winding up
    // on the noise floor. Aiming at the gain currently applied is what makes
    // that a hold: a target left where it was would keep pulling
    if (this._activeBlocks < MIN_ACTIVE_BLOCKS) {
      this._targetGain = this.gain;
      return;
    }
    const meanSquare =
      (this._sumLeft + this._sumRight) / this._activeBlocks;
    if (meanSquare <= 0) {
      return;
    }
    const loudness = LUFS_OFFSET + 10 * Math.log10(meanSquare);
    const gain = Math.pow(10, (this._targetLufs - loudness) / 20);
    this._targetGain = Math.min(this._maxGain, Math.max(this._minGain, gain));
  }
}

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
    this._normalizer = new LoudnessNormalizer(sampleRate, options.normalize);
    this._normalizer.enabled = Boolean(options.normalize.enabled);
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
      // The renderer sends back the memory of a block it has finished with,
      // and turns the normaliser on and off, over the same port
      if (returned && returned.type === "normalize") {
        this._normalizer.enabled = Boolean(returned.enabled);
        return;
      }
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
      const l = left ? left[i] : 0;
      const r = right ? right[i] : 0;
      // The normaliser measures the mix as it arrives and the limiter catches
      // whatever that leaves, so the ceiling holds however much gain is added
      const gain = this._normalizer.process(l, r);
      this._limiter.process(l * gain, r * gain, output, i);
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
        normalization: this._normalizer.gain,
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
