# Third-party notices

## Cmajor

The Cmajor compiler files in `public/cmaj_api/` are distributed under Cmajor's GPL-3.0-or-later option. Cmajor is copyright Cmajor Software Ltd.

- Project and corresponding source: <https://github.com/cmajor-lang/cmajor/tree/4ba0924f3933d9650fb6a8f01f652a7236344604>
- Browser binary snapshot: <https://github.com/cmajor-lang/docs/tree/bf391feddbf652835ad52c2514af7c8e0e5d4a6a/cmaj_api>
- License: <https://github.com/cmajor-lang/cmajor/blob/4ba0924f3933d9650fb6a8f01f652a7236344604/LICENSE.md>
- Build script: <https://github.com/cmajor-lang/cmajor/blob/4ba0924f3933d9650fb6a8f01f652a7236344604/tools/wasm_compiler/build.py>

The Cmajor browser helper files retain their individual upstream ISC or GPL notices. Local modifications are provided in this repository under GPL-3.0-or-later without removing those existing permissions or notices.

Official Cmajor example projects are not copied into this repository. The application downloads a selected example directly from the pinned Cmajor source revision above. “Sine tone” is adapted from the Cmajor Getting Started guide. “Gran Vals melody” is adapted from Cmajor's `examples/patches/HelloWorld`, whose melody is attributed upstream to Francisco Tárrega.

## MIT-licensed components

- Compost Web Components, copyright © 2026 Charlie Culbert
- MIDI scheduling code adapted from `charCulbert/wclap-web-audio` at commit `2ca89137fbaed6fe0e6db21525de996e8783654b`, copyright Charlie Culbert
- CodeMirror 6 and Lezer packages, copyright Marijn Haverbeke and contributors
- `@replit/codemirror-vim`, copyright Marijn Haverbeke and contributors

These components are used under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the “Software”), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Build-only dependencies and their exact versions are recorded in `package-lock.json`; their license files are included in their published npm packages.
