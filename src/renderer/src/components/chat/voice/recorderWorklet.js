// The voice recorder's AudioWorklet: copies each 128-frame block of channel 0
// to the main thread, which joins and encodes them on stop. A real file, loaded
// by URL (`?url&no-inline`): the renderer CSP blocks blob: and data: modules.
class CinnaRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(channel.slice(0))
    return true
  }
}

registerProcessor('cinna-recorder', CinnaRecorderProcessor)
