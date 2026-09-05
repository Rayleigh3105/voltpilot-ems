# ECharts tooltip formatters return raw HTML - never interpolate API/user-controlled strings into them.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 030).

- **ECharts tooltip `formatter`s return raw HTML - never interpolate API/user-controlled strings into them.** ECharts inserts the returned string via innerHTML, so a customer-controlled value (site/tenant/device name, `external_ref`, ...) interpolated there would be a stored XSS (e.g. triggered when a platform-admin views that tenant via the switcher). Today every formatter interpolates only static series labels plus `format.ts`-formatted numbers/timestamps - keep it that way; if a dynamic string ever must appear, HTML-escape it first.
