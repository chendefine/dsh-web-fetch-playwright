## What this change does

<!-- One or two sentences: the behavior or file it changes, and why. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (new behavior has a test)
- [ ] `pnpm build` succeeds and the client bundle stays self-contained
- [ ] `CHANGELOG.md` updated and `package.json` version bumped if user-visible
- [ ] `pnpm pack --dry-run` shows `lib/index.js` and `lib/client.js` in the tarball

## Notes for the reviewer

<!-- Anything the maintainer should look at carefully: a subtle resolution path, a cap change, an error-taxonomy decision, … -->
