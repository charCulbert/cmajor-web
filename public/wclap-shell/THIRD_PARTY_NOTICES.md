# Third-party notices

## Cmajor patch-view API (`ui/cmaj_api`)

- Files: `cmaj-patch-connection.js`, `cmaj-patch-view.js`, `cmaj-generic-patch-view.js`,
  `cmaj-parameter-controls.js`, `cmaj-piano-keyboard.js`, `cmaj-midi-helpers.js`,
  `cmaj-event-listener-list.js`, `cmaj-version.js`, `assets/cmajor-logo.svg`, copied
  unmodified from `javascript/cmaj_api` at Cmajor revision
  `4ba0924f3933d9650fb6a8f01f652a7236344604`.
- License: ISC, see `THIRD_PARTY_LICENSES/cmaj_api-ISC.txt`.
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
