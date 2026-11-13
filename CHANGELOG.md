# Changelog

## 0.1.0

First release.

- Pi extension: measures decode, TTFT and prefill from native Pi hooks and publishes them on the
  session event bus.
- Pi Web plugin: session-row label (`⚡ 27.4 tok/s`) and "Token Speed" side panel with turn history.
- Presence gate: no measurement at all when the web plugin is not connected.
- Handles tool calling, interruptions, regenerations and model switches (state and calibration reset).
