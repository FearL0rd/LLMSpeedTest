# Bumping the Version & Cutting a Release

Releases are tag-driven. Pushing a tag that starts with `v` (e.g. `v0.1.3`)
triggers the **Release** workflow (`.github/workflows/release.yml`), which
builds the app on Windows and Linux in the cloud and attaches the installers
to a **draft** GitHub release for you to review and publish.

## Steps

1. **Bump the version** in `src-tauri/tauri.conf.json` (`"version"`), and
   keep `package.json` / `src-tauri/Cargo.toml` aligned. The version embedded
   in the installers comes from `tauri.conf.json`.

2. **Commit and push the bump:**

   ```bash
   git add -A
   git commit -m "chore: bump version to 0.1.3"
   git push origin main
   ```

3. **Create the tag and push it:**

   ```bash
   git tag v0.1.3        # tag must start with "v" and match the conf.json version
   git push origin v0.1.3 # triggers the Release workflow
   ```

4. The GitHub **Actions** tab shows the two builds (Windows: MSI + NSIS +
   portable exe zip; Linux: deb + rpm + AppImage). First build takes
   ~10–15 minutes per platform while dependencies compile.

5. When both jobs finish, open **Releases** → the new **draft** release — check
   that all assets are attached, then hit **Publish release**.

## If something goes wrong

- **Wrong tag or bad content:** fix the commit, then delete and recreate the
  tag locally and remotely:

  ```bash
  git tag -d v0.1.3
  git push origin :v0.1.3   # delete the remote tag
  git tag v0.1.3 && git push origin v0.1.3
  ```

- **Failed workflow run:** read the job log in Actions, fix the cause, then
  re-run the job from the Actions page (no new tag needed).

- **Version drift:** if you forget step 1, the installers report the old
  version even though the tag is new. Keep the tag and `tauri.conf.json`
  versions identical.
