# Third-party notices

## dsh-pet-dafeiyu

Source: https://github.com/bauerelizabeth07139/dsh-pet-dafeiyu

Pinned revision: fc1ad4c0fa29ee29338a469c74ebe7776bf3d66a

Copyright (c) 2026 bauerelizabeth07139. MIT license; full text in `third_party/dsh-pet-dafeiyu/LICENSE` in the source and `assets/UPSTREAM-LICENSE.txt` in the package.

The prototype uses the upstream icon and selected PNG poses. The breath animation and per-pose facing calculation in `src/ui/pet.ts` are adapted from upstream `lib/client.js`. DSH, React, voice, BGM, spontaneous dialogue and family-link functionality are not included.

The upstream README states that character artwork is derived from original community artwork through image-to-image generation. The MIT file is the repository's declaration and does not independently establish the rights to underlying character art or trademarks. This is a local development prototype; verify artwork provenance or replace the skin before public distribution. No affiliation with DeepSeek is implied.

Individual asset checksums are recorded in `assets/SOURCES.json`.

## Mozilla Readability

Source: https://github.com/mozilla/readability — Apache-2.0. Used for local article extraction. A copy of the dependency license is included in `assets/READABILITY-LICENSE.txt` when building.

## Rich explanations

- Markdown-it (MIT): https://github.com/markdown-it/markdown-it — Markdown parsing.
- KaTeX (MIT): https://github.com/KaTeX/KaTeX — mathematics layout and bundled fonts.
- Highlight.js (BSD-3-Clause): https://github.com/highlightjs/highlight.js — code highlighting.
- DOMPurify (Apache-2.0 OR MPL-2.0): https://github.com/cure53/DOMPurify — markup sanitization.
- Mermaid (MIT): https://github.com/mermaid-js/mermaid — diagrams, loaded locally inside a sandbox when needed. Its distributed bundle retains dependency notices.

Copies of the runtime library licenses are in `vendor/*-LICENSE.txt` in the package. No library, font or diagram script is loaded from a public CDN.
