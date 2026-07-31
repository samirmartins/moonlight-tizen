# Samsung Tizen notes

Moonlight Tizen adapts Moonlight Chrome to Samsung TVs through WebAssembly. Its main platform layer is under `wasm/` and uses Samsung's [Tizen WASM Player](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/tizen-wasm-player/overview.html) and [Sockets Extension](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/api-reference/tizen-sockets-extension.html).

Dependencies are vendored in this repository; no Git submodule initialization is required.

- To install a release, see the [Installation Guide](INSTALLATION.md).
- To build locally, see the main [README](README.md#building).
- For the faster two-stage build, see the [build tools guide](build-tools/README.md).
