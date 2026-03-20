# pi-apply-patch

A **pi** extension that registers an `apply_patch` tool for applying high-level patches in the `*** Begin Patch` / `*** End Patch` format.

This variant is **YOLO**: it **does not ask for confirmation** (even in interactive/UI mode). Patches are applied immediately.

## Disclaimers

- **No project boundary enforcement.** It allows editing or moving files outside the project root.
- **Vibe Coded Code.** But has been in use for months in mac and linux environments.

## Install

### Install as a pi package (recommended)

Global install:

```bash
pi install git:https://github.com/rkunnamp/pi-apply-patch
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l git:https://github.com/rkunnamp/pi-apply-patch
```

To try it for a single run without installing:

```bash
pi -e git:https://github.com/rkunnamp/pi-apply-patch
```

## What it provides

- Tool name: **`apply_patch`**
- Operations:
  - `*** Add File:`
  - `*** Update File:` (supports optional `*** Move to:` rename)
  - `*** Delete File:`
- Safety:
  - Relative paths are resolved against the current project directory (`ctx.cwd`).
  - Absolute paths may point anywhere on the filesystem.
  - **No confirmation prompt**.

## Patch format

```text
*** Begin Patch
*** Update File: path/to/file
@@ optional context line
  unchanged line
- removed line
+ added line
*** End Patch
```

## Development

This repo is structured as a pi package:

- `package.json` declares the pi manifest under `pi.extensions`
- Extension source lives in `extensions/apply-patch/`

To update locally for your own pi install, you can either:
- reinstall (`pi update` / `pi install ...`), or
- symlink/copy the `extensions/apply-patch` folder into `~/.pi/agent/extensions/` and use `/reload`.
