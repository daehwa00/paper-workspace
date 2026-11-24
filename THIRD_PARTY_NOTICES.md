# Third-party notices

The public distribution contains or runs the following third-party software.

- **PDF.js 6.1.200 (legacy browser build)** is redistributed under the Apache License 2.0. Its complete notice is retained at `apps/paper_workspace/static/vendor/pdfjs/LICENSE`. The bundled core-js compatibility code is covered by the MIT license at `apps/paper_workspace/static/vendor/pdfjs/LICENSE-core-js`.
- **Yjs**, **y-websocket**, **y-indexeddb**, and **y-leveldb** provide MIT-licensed conflict-free shared text, awareness, offline persistence, and server persistence. Exact versions are locked in `apps/paper_workspace/collaboration/package-lock.json`.
- **Caddy**, **nginx-unprivileged**, **Python**, **TeX Live**, and their Linux packages are downloaded as container dependencies under their respective licenses.
- **OpenAI Codex CLI** is installed in the optional bridge container. Use of Codex remains subject to the applicable OpenAI terms and account permissions.
- The response preview bundles **marked** (MIT), **MathJax** (Apache 2.0), and **DOMPurify** (MPL 2.0 or Apache 2.0). License texts are in `apps/paper_workspace/static/vendor/response-preview-licenses/`.

Conference author kits, manuscripts, datasets, experiment outputs, and private credentials are not part of the public distribution. Bring your own venue template only when its redistribution and use terms permit it.


## Rebuttal runtime dependencies

The optional rebuttal service uses the official
[OpenReview Python client](https://github.com/openreview/openreview-py).
The compiler image installs [Pandoc](https://github.com/jgm/pandoc) for
Markdown-to-LaTeX conversion and Poppler for PDF inspection/extraction.
Upstream license notices remain in their installed distributions; these runtime
components are not relicensed by the workspace MIT license.

## UI font

Inter Variable is bundled from the [official Inter project](https://github.com/rsms/inter) under SIL Open Font License 1.1. The complete license is retained at `apps/paper_workspace/static/assets/inter-LICENSE.txt`; the unmodified font is `inter-variable.woff2`.
