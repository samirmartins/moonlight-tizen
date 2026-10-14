# Contributing

Issues and focused pull requests are welcome.

## Issues

Use the [issue templates](https://github.com/samirmartins/moonlight-tizen/issues/new/choose).
Include app/TV/Tizen versions, installation method and reproduction steps.
Mask private addresses and identifiers; never attach credentials, pairing/input
keys, private certificates or unredacted logs.

## Development

For runtime changes, run from the repository root:

```bash
bash build-tools/run-tests.sh
```

See the [build guide](../build-tools/README.md) for dependencies, baseline tags,
Samsung compilation, Normal/ForceGM and local signing. Dependencies are vendored;
no submodule initialization is required.
Documentation-only changes need content/link checks, not a build or TV test.
Report tests actually run and any remaining hardware validation.

## Pull requests

- Keep one fix/feature per PR and avoid unrelated refactoring.
- Explain the reason, user-visible effects, tests and known limitations.
- Document dependency changes and the relevant upstream source.
- Keep private information out of source, screenshots, logs and commit metadata.

By participating, you agree to the [Code of Conduct](../CODE_OF_CONDUCT.md).
