# Contributing

Issues and focused pull requests are welcome.

## Issues

Use the appropriate [issue template](https://github.com/samirmartins/moonlight-tizen/issues/new/choose). Include the Moonlight version, TV model, Tizen version, installation method, reproduction steps and relevant logs. Mask private addresses.

## Development

Build the project locally before opening a pull request:

```bash
docker build --ulimit nofile=1024:524288 -t moonlight-tizen .
```

Add `--build-arg FORCE_GAME_MODE=1` for the ForceGM variant. See the
[build guide](../build-tools/README.md) for the faster two-stage workflow.
Dependencies are vendored; no submodule setup is required.

## Pull requests

- Keep each pull request limited to one fix or feature.
- Explain what changed, why, and how it was tested.
- Follow the existing style and avoid unrelated refactoring.
- Document user-visible behavior changes.
- Explain any change to vendored dependencies and reference its upstream source when applicable.

By participating, you agree to the [Code of Conduct](../CODE_OF_CONDUCT.md).
