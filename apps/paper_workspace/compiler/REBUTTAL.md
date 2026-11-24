Rebuttal PDF APIs use isolated temporary workspaces and never populate manuscript
compile, SyncTeX or build-state caches. The compiler remains an internal service;
its container network must not provide internet egress.

`POST /extract-review` accepts a base64 PDF of at most 10 MB and 100 pages. Scanned
PDFs without extractable text are rejected; OCR is not performed.

`POST /rebuttal-render` accepts Markdown documents and an optional template with
`files` and `entrypoint`. The entrypoint must contain exactly one literal
`%%REBUTTAL_BODY%%` placeholder, replaced by the Pandoc-produced LaTeX body. With
no template a neutral article layout is used. Raw TeX/HTML blocks in Markdown are
disabled. Templates may declare ordinary TeX classes/packages but cannot invoke
file-reading/writing primitives, dynamic command construction, shell commands,
or Lua. Assets must be base64 request-local files, with safe relative paths.
Remote image URLs and file paths outside the request workspace are rejected.

Two dedicated request slots bound work; each operation has a wall deadline and
child-process CPU, memory and file-size limits. Pandoc uses `--sandbox`; pdflatex
uses `-no-shell-escape` with paranoid file access. Child environments omit app
credentials and proxies. The container requires Pandoc, Poppler and util-linux
in addition to TeX. The response includes the base64 PDF, actual page count, and
rendered source files so source exports can reproduce the artifact with the same
TeX toolchain and request assets.
