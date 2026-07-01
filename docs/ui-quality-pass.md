# UI quality pass (portal + design system)

Final polish pass over the whole web portal, driven by a real-browser audit against an isolated stack (seeded demo data, both roles, phone/tablet/desktop viewports).
Method: audit -> fix -> re-verify, looped until a full pass at 375x812, 390x844, 768x1024, 1024x768 and 1440x900 produced no remaining findings.
Every item below was found in the running product, fixed, and verified again in the browser.

## Goals (captain's order)

1. Must not look AI-generated - no mixed icon languages, no internal jargon, no inconsistencies.
2. Modern, professional SaaS-grade UI.
3. No open usability gaps (loading/empty/error states, interactions, information access).
4. Phone and tablet must be perfect.

## Findings -> fixes (found -> fixed -> verified)

### "AI-coded tells" removed

| Finding | Fix |
|---|---|
| Icons were mixed unicode glyphs (`◧ ⌂ ⚡ € ☀ ⛁ ◷ ◩ ☺ ∿ ≣ ▲ ▼ ✕ ☰ ‹ ›`); some render as colored emoji on macOS/iOS/Android, others as gray text - a glaring machine-output look | New design-system `Icon` component (`designsystem/components/core/Icon.jsx`): one consistent 24px/2px-stroke SVG set (Lucide paths, ISC), used across nav, tiles, KPI cards, buttons, drawer close, hamburger, timeline and steppers |
| Fullwidth "＋" character in every add-button | Real `plus` icon via `Button iconLeft` |
| Customer top bar showed `Mandant 00000000` (a UUID slice) | Removed - a customer's tenant is fixed by the login; the chip carried zero information. Admins keep the real tenant switcher |
| Sidebar footer leaked a repo path (`docs/connect-a-device.md`) | Plain wordmark footer |
| Übersicht footnote exposed the internal pipeline ("MQTT → Ingest → Redpanda → TimescaleDB") | "Messwerte Ihrer Geräte aus den letzten 24 Stunden." |
| "keyless", "Collector", "PT15M", "Slots @ PT15M", "(Guards, §14a)", "BYPASSRLS/RLS", "(Keycloak, tenant-gebunden)" in user-facing copy | Rewritten in customer language ("15-Minuten-Takt", "wird automatisch geladen, sobald die Börse veröffentlicht", "u. a. §14a EnWG", note removed entirely, "Kundenzugänge je Mandant verwalten") |
| English chart legends in the German UI ("Load", "Net power", "Battery SoC", "Day-Ahead") | German everywhere ("Last", "Netz", "SoC", "Börsenpreis") |
| Dot decimals from `toFixed()` in a German UI ("72.7", "19.6 kW") | All numbers through `de-DE` locale formatting (`format.ts`), number+unit joined with a non-breaking space so they never wrap apart |
| Straight closing quotes (`„Standorte"`) | Proper German quotes (`„Standorte“`) |
| Raw backend enum values in the UI (`inverter`, `CI`, `mvp`) | German labels (`Wechselrichter`, `Gewerbe & Industrie`, `MVP`) via `deviceKindLabel`/`segmentLabel` |
| Raw coordinates (`52.52, 13.405`) | Formatted `52,5200° N · 13,4050° O` (`fmtCoords`); dropped from the overview site cards entirely |
| "Anmelden mit Keycloak" + docker hint in the login error | "Anmelden"; friendly outage message |
| `<html lang="en">`, title "Voltpilot-EMS Portal" | `lang="de"`, "VoltPilot EMS" |
| "Telemetrie" as customer vocabulary | "Live-Daten" / "Messwerte" throughout |

### Readability / visual quality

| Finding | Fix |
|---|---|
| Stat/KPI numbers in light blue `--vp-primary-dark` (#7BA3F7): ~2.5:1 contrast on white - fails WCAG even for large text, and reads washed-out | New portal-scoped semantic token `--vp-stat-ink` (navy); `Stat` + `KpiCard` value color now token-driven with the old color as fallback for the marketing surfaces |
| Stat scale (up to 3rem) made values like "167.3 EUR/MWh" wrap mid-value inside the stats grid | New `--vp-text-stat-sm` scale for the dashboard; long units (EUR/MWh, W/m², kWh at stats) moved into the label ("Maximum (EUR/MWh)") |
| Badge `warn` text #F57C00 on #FFF3E0: 2.5:1 | #B45309 (4.6:1); `off` badge darkened to #57606A |
| KPI cards: 2rem padding left ~84px for text -> labels wrapped to 3 lines | Tighter KPI padding (1.25/1.5rem), grid min column 205px |
| PriceChart mislabeled the yesterday/today boundary as "Morgen" when the API returns yesterday's prices too | Divider now anchored to the actual local tomorrow; the widget shows today+tomorrow only |
| Charts clipped axis names on phones (fixed 56px gutters) | `containLabel: true` grids everywhere; tightened margins |
| Weather chart's three y-axes ate half a phone screen | Below 520px the cloud/irradiance axes hide (values stay in the tooltip); charts re-render on resize so rotation adapts |
| Wrapped legends overlapped the plot on phones (Historie/Fahrplan) | Width-aware `grid.top` |
| Responsive-table labels inherited mono font in mono cells | Labels forced to Inter |

### Usability gaps closed

| Finding | Fix |
|---|---|
| Create-site coordinate errors appeared as a distant banner | Inline field errors on Breiten-/Längengrad (range-checked, German examples), `inputMode="decimal"` for the right mobile keyboard |
| "Benutzer deaktivieren" fired without confirmation | Confirm dialog (both admin pages) |
| Admin's tenant selection was lost on every reload (back to "Mandanten-Kontext wählen") | Selection persists in `sessionStorage`, validated against the tenant list |
| Device status badge duplicated the "Zuletzt gesehen" column ("offline · vor 6 Min." next to "vor 6 Min.") | Badge shows the status only; the column carries the time |
| Drawer: no focus management, background scrolled behind it, 100vh clipped on mobile browsers | Focus moves into the panel (and back on close), body scroll locks, `100dvh`, no focus ring on the panel |
| Mobile nav: no `aria-expanded`, no Escape, background scrolled | All three added; hamburger switches to an X while open |
| Historie steppers/segmented tabs below 44px on touch | 44px minimum on coarse pointers / <=720px |
| Savings-today filtered slots by day-of-month only (`getDate()`) - wrong across months | Full local-date comparison (Übersicht + Fahrplan) |
| Admin phone top bar: breadcrumb + tenant switcher + user menu didn't fit | Breadcrumb yields to the switcher below 720px (`:has(.vp-context)`); the page h1 carries the title |
| Error states showed raw "Preis-Fehler: 404" style text | Human sentences with a retry hint on every data page |

## Verification

- `npm run build` (tsc + vite) green after every wave.
- Browser matrix re-run after the fixes: Übersicht, Standorte, Geräte (incl. zero-touch claim flow with success checklist), Marktpreise, Wetter, Fahrplan, Historie (Tag/Woche/Monat/Jahr) at 375x812, 390x844, 768x1024, 1024x768, 1440x900 - customer role; admin role additionally Mandanten/Benutzer, tenant switcher, tenant detail drawer, create flows, login/logout.
- Final adversarial pass greps for glyph icons, straight German quotes, `toFixed`, and internal-jargon vocabulary come back clean.

## Conventions going forward

- Icons only through the design-system `Icon` set (see its `.prompt.md`); no unicode glyph icons.
- All user-visible numbers through `format.ts` (de-DE, NBSP before units).
- User-facing copy never names internal components (broker, pipeline, roles, tools); it describes what the customer gets.
- Dashboard stats use `--vp-stat-ink` / `--vp-text-stat-sm`; long units belong in the label, not the value.
