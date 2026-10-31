# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Set up

You need an Apple Silicon Mac, [uv](https://docs.astral.sh/uv/), [pnpm](https://pnpm.io) and Rust.

```bash
uv sync
uv run studio serve --mock        # backend with placeholder images, no model download
cd app && pnpm install && pnpm tauri dev
```

`--mock` draws placeholders, so you can work on the UI, pipeline and MCP bridge without the
32 GB model. Use pnpm for `app/` and `website/` (not npm or yarn).

## Before you open a pull request

```bash
uv run pytest -q tests/
cd app && pnpm exec tsc -b && pnpm exec vite build
```

- Keep changes focused; one topic per pull request.
- `docs/ARCHITECTURE.md` is the contract for `story.yaml`, the HTTP API and the MCP tools. Update
  it when you change any of them.
- UI copy is short and plain, without em dashes. Motion respects reduced motion.
- Never commit generated images (`stories/*/out`, `final/`), `.env` files or model weights.
- If users will notice the change, add a line to `## [Unreleased]` in `CHANGELOG.md`:

  ```bash
  scripts/changelog.sh add "Bubbles no longer jump when a panel is cropped" --type fixed
  ```

  Types: `added`, `changed` (default), `fixed`, `removed`, `deprecated`, `security`. The next
  release turns these notes into its section and its GitHub release notes
  ([docs/RELEASING.md](docs/RELEASING.md)).

## License

By contributing you agree that your contributions are licensed under the
[BSD 3-Clause License](LICENSE).

## How changes land on main

`main` is protected. Every change goes through a pull request that needs:

- one approving review from someone with write access (a collaborator or a maintainer),
- the three CI checks green: Backend tests, App (typecheck, build, cargo check), Website build,
- every review thread resolved. New commits dismiss earlier approvals.

Fork, branch, and open the PR against `main`. Repository admins can bypass the rules for releases.

Be decent to each other: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
