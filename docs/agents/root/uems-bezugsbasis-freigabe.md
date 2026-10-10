# UEMS-Bezugsbasis: Freigabe, Fassung n + 1, Verantwortlicher (AP-17 IP-8, F1/F2/F4/A1/B3/B4)

Neu am 23.09.2026: `POST …/bezugsbasen/{bid}/fassungen/{n}/beantragen · freigeben · ablehnen`,
`PUT …/bezugsbasen/{bid}/verantwortlicher`, `GET /api/v1/kennzahlen/{id}/bezugsbasen` (Liste in der Form der Einzel-Basis),
`bezugsbasis {kennzeichen, fassung, freigabe_status, vorlaeufig}` am Kennzahl-Register (B3) und
Anpassungsgründe/`gilt_ab` am Entwurf. Vertrag: `docs/contracts/v2/bezugsbasis.md` §13. Beenden, „bleibt“ und die Übersicht
liegen bei IP-17 (`BezugsbasisPflegeController`), der Vergleich bei IP-19.

| Stelle | Was |
|---|---|
| `BezugsbasisService#freigeben` | ohne Vier-Augen: Entwurf → `freigegeben` (`freigabe_*`); mit Vier-Augen: nur `beantragt` → `freigegeben` durch eine zweite Person (`entscheidung_*`); beendet vorher die laufende freigegebene Vorgängerin am Vortag des `gilt_ab` |
| `BezugsbasisService#anpassung` | ab Fassung 2 (auch nach einer ABGELEHNTEN Fassung 1 — so will es `bezugsbasis_fassung_anpassungsgruende_chk`) Anpassungsgründe + Begründung Pflicht |
| `KennzahlRepository#bezugsbasis` | laufende Basis, Fassung = laufende freigegebene, sonst jüngste; das Portal leitet „Energieleistungskennzahl“ aus `freigabe_status = freigegeben` ab — keine Spalte an `kennzahl` (B3) |

⚠ **Beantragen braucht `bezugsbasis.freigeben`, nicht `verwalten`:** wer beantragt, ist die Freigabe-Person, und
`bezugsbasis_fassung_freigabe_chk` erlaubt dort nur KA/EM (Bearbeiter → 403 statt CHECK-Fehler).
⚠ **Vier-Augen:** die zweite Person ist weder `actor_sub` (gebildet) noch `freigabe_sub` (beantragt) → 422 `vieraugen_urheber`;
eine Begründung beim Bestätigen steht nur im Protokoll (`entscheidungs_begruendung` ist per CHECK nur für `abgelehnt`).
⚠ **Eingefroren:** nach dem Entwurf ändert der Trigger nur Entscheid und Ende — Anpassungsgründe, Begründung und
`vieraugen` müssen im selben UPDATE wie der Statuswechsel gesetzt werden.
⚠ **Am Freigabetag (Nachlese 2, §13/§17):** `beantragen`/`freigeben` bilden die Grundlage VOR der Sperre neu
(`BezugsbasisService#amFreigabetag` — eine Ablehnung beim Neubilden in der Transaktion würde sie vergiften) und wenden
das Ergebnis danach an (`#anwenden`): andere Prüfsumme → 409 `entwurf_veraltet`; geänderte Faktoren → Neukopie nur im
Entwurf (ab `beantragt` friert der Trigger ein → 409), Protokoll-Anlass `faktoren_neu_kopiert` am Wort des Entscheids.
Wer die Grundlage um eine Eingabe erweitert, muss sie in `#neuGebildet` genauso lesen, sonst ist jeder Entwurf veraltet.
Nachweis: `BezugsbasisApiTest` (Docker), `BezugsbasisGrundlageTest` (OpenAPI), `RechtMatrixApiTest`, `RechtRoutenArchitekturTest`.
