# Third-party notices

## Cmajor patch-view API (`ui/cmaj_api`)

- Files copied unmodified from `javascript/cmaj_api` at Cmajor revision
  `4ba0924f3933d9650fb6a8f01f652a7236344604`, copyright Cmajor Software Ltd. Each file is
  licensed as its own header states:
  - ISC, see `THIRD_PARTY_LICENSES/cmaj_api-ISC.txt`: `cmaj-patch-connection.js`,
    `cmaj-patch-view.js`, `cmaj-generic-patch-view.js`, `cmaj-parameter-controls.js`,
    `cmaj-midi-helpers.js`, `cmaj-event-listener-list.js`.
  - GPLv3, see `THIRD_PARTY_LICENSES/cmaj_api-GPL-3.0.txt`: `cmaj-piano-keyboard.js`.
  - `assets/cmajor-logo.svg` has no header; it is Cmajor's logo, distributed with Cmajor
    under its GPLv3 option.
- `cmaj-version.js` is not from Cmajor; it is part of this shell and covered by
  GPL-3.0-or-later (`LICENSE.txt`).
- These render patch GUIs (the patch's own `view` or Cmajor's generic view) the same
  way the native Cmajor plug-in does.

## Linked patches

A plug-in exported from Cmajor Web contains, in addition to this shell, the DSP compiled
from the patch's Cmajor source by the Cmajor compiler and the patch's own GUI files.
Their licensing is the patch author's; the Cmajor compiler and its generated code are
covered by Cmajor's own license terms (see <https://github.com/cmajor-lang/cmajor>).

## Build dependencies (submodules under `external/`)

- CLAP (MIT), clap-helpers (MIT), clap-wrapper fork (MIT), CHOC fork (ISC),
  char-clap-utils (ISC). Each carries its own license file.
