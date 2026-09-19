import { Howl } from "howler";
import { TypedEmitter } from "tiny-typed-emitter";

import { toPlaybackURL } from "../../common/mediaURL";
import { WebAudioTrack } from "../../common/WebAudioTrack";

export interface SoundEvents {
  error: () => void;
  load: (duration: number) => void;
  end: () => void;
}

type SoundOptions = {
  src: string;
  volume: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
};

/**
 * The part of the playback API a sound uses once its instance exists.
 * The two are kept apart because each mode needs something the other can't
 * give: a perfect loop needs the whole file decoded into a buffer, which is
 * Howler's Web Audio mode, and a cross fade needs a gain that can be moved on
 * the audio clock while the file is streamed, which is `WebAudioTrack`.
 */
interface SoundPlayback {
  stop(): void;
  unload(): void;
  playing(): boolean;
  duration(): number;
  seek(): number;
  seek(to: number): void;
  volume(): number;
  volume(volume: number): void;
  loop(loop: boolean): void;
  on(
    event: "play" | "load" | "end" | "loaderror" | "playerror",
    fn: () => void,
  ): void;
  once(event: "fade", fn: () => void): void;
  fade(from: number, to: number, duration: number): void;
}

/**
 * Cross fade wrapper around a sound playback.
 * Setting fadeIn and fadeOut to 0 will disable cross fading.
 * If cross fading is disabled then the file is decoded up front
 * this increases the memory usage but allows for perfect loops.
 */
export class Sound extends TypedEmitter<SoundEvents> {
  options: SoundOptions;
  /** Timeout that controls the cross-fade */
  _timeout: NodeJS.Timeout;
  /** Current audio playback for this loop */
  _playback: SoundPlayback;

  constructor(options: SoundOptions) {
    super();
    this.options = options;
    try {
      const createInstance = () => {
        const crossFade =
          this.options.fadeIn !== 0 && this.options.fadeOut !== 0;
        // A cross fading sound is streamed through Web Audio, where its fades
        // are scheduled on the audio clock and so move per sample rather than
        // in the steps a timer can manage. A looping sound is left to Howler,
        // which loops a decoded buffer without the gap an element leaves
        const playback: SoundPlayback = crossFade
          ? new WebAudioTrack({
              // Converted by the track itself, which has to know whether the
              // URL it ended up with is one it can route through Web Audio
              src: this.options.src,
              volume: 0,
              loop: false,
              autoplay: true,
            })
          : new Howl({
              ...this.options,
              // Served over the app's own scheme so that the decode isn't a
              // cross origin read of a `file://` URL
              src: toPlaybackURL(this.options.src),
              loop: this.options.loop,
              volume: this.options.volume,
              autoplay: true,
              html5: false,
            });

        const handleCrossFade = () => {
          // Fade in
          playback.fade(0, this.options.volume, options.fadeIn);
          // Fade out
          clearTimeout(this._timeout);
          this._timeout = setTimeout(
            () => {
              if (this.options.loop) {
                // Cross fade on loop
                playback.once("fade", () => {
                  // The next loop has its own instance, so this one is done
                  // with rather than idle: an element and its graph nodes are
                  // held for as long as anything points at them
                  playback.unload();
                });
                playback.fade(playback.volume(), 0, this.options.fadeOut);
                createInstance();
              } else {
                // Basic fade out when not looping
                playback.fade(playback.volume(), 0, this.options.fadeOut);
              }
            },
            Math.floor(playback.duration() * 1000) - this.options.fadeOut,
          );
        };

        const handleLoad = () => {
          this.emit("load", playback.duration());
        };

        const handleEnd = () => {
          if (!this.options.loop) {
            this.emit("end");
          }
        };

        const handleError = () => {
          this.emit("error");
        };

        if (crossFade) {
          playback.on("play", handleCrossFade);
        }
        playback.on("load", handleLoad);
        playback.on("end", handleEnd);
        playback.on("loaderror", handleError);
        playback.on("playerror", handleError);

        if (playback instanceof Howl && !(playback as any)._sounds[0]) {
          handleError();
        }

        this._playback = playback;
      };
      createInstance();
    } catch {
      this.emit("error");
    }
  }

  async stop(fadeOut: boolean): Promise<void> {
    return new Promise((resolve) => {
      clearTimeout(this._timeout);
      // Nothing audible to fade out, and a fade that is waited on here has to
      // be one that is going to arrive
      if (fadeOut && this._playback.playing()) {
        this._playback.once("fade", () => {
          this._playback.unload();
          resolve();
        });
        this._playback.fade(this._playback.volume(), 0, this.options.fadeOut);
      } else {
        this._playback.unload();
        resolve();
      }
    });
  }

  playing() {
    return this._playback.playing();
  }

  progress() {
    return this._playback.seek();
  }

  seek(to: number) {
    this._playback.seek(to);
  }

  volume(volume: number) {
    this.options.volume = volume;
    this._playback.volume(volume);
  }

  loop(loop: boolean) {
    this.options.loop = loop;
    // Toggle the playback loop if cross fade is disabled
    if (this.options.fadeIn === 0 && this.options.fadeOut === 0) {
      this._playback.loop(loop);
    }
  }
}
