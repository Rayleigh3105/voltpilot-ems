# Stufe 3 „Bis zum Endkunden": der Kunde fährt DIESELBE Register-Strecke

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 5).


Konzept `vp-reg-schreib-konzept-p8` §2.7/§2.8 (Cloud-Seite + die drei Captain-Entscheide:
root `AGENTS.md` „Register schreiben über das Portal, Stufe 3"). Ein ruhiger
`<details>`-Aufklapper „Experten-Werkzeuge" im Abschnitt „Ihre Geräte" des
Anlagen-Modells (`pages/AnlagenModellSection.tsx` `RegisterExperte`).

- **⚠ Es entsteht KEINE zweite Strecke.** Er hostet den BESTEHENDEN
  `RegisterWriteDrawer` — dieselben Warnklassen, derselbe Beleg, dieselbe
  Rückfrage —, also können Kunde und Plattform-Admin über denselben Vorgang nie
  Verschiedenes sehen. Wer hier eine „Kunden-Variante" des Drawers baut, hat die
  Zusage gebrochen, für die es die Stufe gibt.
- **Bewusst ein Aufklapper, kein prominenter Knopf** (§2.7): die Freiheit ist da,
  die Fläche bleibt ruhig. Ohne verbundenes Gerät nennt er den GRUND
  (`kundenRegisterZugang`), statt einen Knopf anzubieten, der strukturell nichts
  bewirken kann — die `registerZugang`-Regel des Hauses (ein Knopf, der strukturell nichts bewirken kann, wird nicht angeboten - dort steht der Grund).
- **⚠ Der VERANTWORTUNGS-Satz steht in der FOLGENLISTE der Rückfrage**
  (`bestaetigungsFolgen()`, EINE Quelle für Drawer und Test), nicht nur als
  Kleingedrucktes im Formular: die Rückfrage ist der Moment, in dem ein Mensch
  die Folgen abwägt, und eine Eigenverantwortungs-Erklärung, die er beim Scrollen
  überliest, ist keine. Er steht ZULETZT (er fasst die drei Zeilen darüber
  zusammen) und gilt für JEDE Herkunft — auch VoltPilot schreibt auf eigene
  Verantwortung in ein Kundengerät; ein milderer Satz für die eigene Mannschaft
  wäre die gefährlichere Variante.
- **D1: die freie LAN-Adresse steht auch dem Kunden offen** — sie ist ohnehin
  Teil des geteilten Drawers. LAN-only prüft die BOX (`probe.IsPrivateHost` +
  die geteilten Vektoren); `freieAdresseFehler` prüft weiterhin nur die FORM.
- **⚠ `zielInput` schickt seit dieser Stufe die GERÄTE-Kennung des gewählten
  Ziels mit.** Auf der Geräteseite war sie überflüssig (dort IST das Gerät die
  Seite), auf der Anlagen-Fläche ist sie tragend: eine Anlage kann mehrere Boxen
  haben, und welche den Auftrag ausführt, darf nicht davon abhängen, welche die
  Fläche zufällig als erste geladen hat.
- **Der Mandant reist auf der Kunden-Fläche NICHT mit** (kein `tenantId`-Prop):
  ein Kunde erreicht seine Anlage über den RLS-Zaun, und der
  `X-Tenant-Id`-Umschalter gilt nur einem Portal-Admin.
- Beweise: `registerWrite.test.ts` („Stufe 3: die Kunden-Fläche") ·
  `RegisterWriteDrawer.test.tsx` (Verantwortungs-Satz IN der Rückfrage, ohne
  Klick ist NICHTS geschrieben; die Geräte-Kennung des gewählten Ziels) ·
  `AnlagenModellSection.test.tsx` (der KUNDE ohne Admin-Rolle bekommt ihn; ohne
  Gerät steht dort der Grund).

