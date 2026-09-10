# Portal help handbook

German customer/operator documentation at `#/hilfe` and `#/hilfe/<article>`.
The 25 articles explain the overall energy system, setup, daily views, control,
devices, settings and troubleshooting. This is bundled portal content: no CMS,
backend endpoints or changes to authentication.

## Editing an article

- Edit the appropriate file in `content/`. Keep article and section IDs stable:
  they are bookmarks. `helpHref(id, section)` builds the links, including
  `?abschnitt=<section>`.
- Each article needs a title, summary, search keywords, category, sections and
  related articles. State prerequisites for optional functions. Use the actual
  German UI labels, distinguish planned actions from measured results and avoid
  promising functions that are not available in the portal.
- New article IDs belong in `model.ts`. Wire page-specific entry points in
  `context.ts`; add inline `<HelpLink article="…" />` for forms when useful.
- `HelpArticleView` is shared by the full center and contextual modal.
  Related links stay inside the modal; its footer opens the same article in a
  new tab so the working form stays mounted. The full center remembers the
  current portal page as its return destination.
- Search normalizes German spelling via the existing glossary helper and
  searches headings, synonyms, summaries, prerequisites and body text. All
  query words must match; titles rank first. Search state lives in `?q=` within
  the hash, preserving browser back navigation.

## Screenshots

The committed PNGs in `assets/` show actual React portal components rendered
with frozen, fictional data. They contain no customer account or production
data. Numbered explanations are HTML overlays, so the original image remains
available for zoom and accessible captions.

From `frontend/portal`:

```bash
npx playwright install chromium  # once, if the browser is not installed
npm run help:screenshots          # all 23 captures; uses local port 4176
npm run help:screenshots -- cockpit fahrplan  # selected capture IDs
```

`e2e/help-fixtures.ts` supplies only the development fixture entry
`e2e/help.html`; it is never imported by the production entry. API methods and
API fetches are isolated in that fixture. Capture additionally blocks external
traffic and uses an explicitly fictional map tile. Time, locale, viewport,
network data and example account details are controlled by the capture script.

`e2e/help-captures.mjs` specifies routes, framing and DOM anchors for each
number. If a UI label moves or changes, update its anchor and explanation.
Captures fail for missing anchors or browser errors. The script writes the
image dimensions, alternative text and normalized anchor positions to
`screenshots.generated.json`; do not hand-edit that index. Review the resulting
images after regeneration. Commit both the PNGs and the index together.

Images load as they approach the viewport. The article/search bundle itself is
lazy-loaded, and production builds use hashed asset URLs. Run capture before
validation, rather than concurrently with tests that inspect its output.

## Verification

```bash
npm run typecheck
npm test -- src/help src/nav.test.ts src/shell/AppShell.test.tsx
npm run test:e2e -- help.spec.ts
npm run build
```

The handbook checks verify related links, route coverage, screenshot files and
callout positions. Browser tests cover direct links, empty/error/admin states,
search/back, form preservation, keyboard trapping and focus restoration,
nested screenshot zoom, and phone/tablet/desktop layouts in Chromium/WebKit.

For a local review, start Vite and open `/e2e/help.html#/hilfe`. `?state=empty`,
`?state=error`, `?state=admin` and `?state=single` exercise the shell gates;
`?scene=claim` and `?scene=rule` show the real form components with example data.
These development pages are excluded from `dist/`.
