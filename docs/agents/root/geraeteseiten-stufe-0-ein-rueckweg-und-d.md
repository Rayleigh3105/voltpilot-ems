# Geräteseiten Stufe 0: EIN Rückweg, und die Messbibliothek gehört dem GERÄT

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 146).


Konzept `data/vp-geraeteseite-rahmen-r2` §2.1/§2.3/§7.3/§7.4 (Captain-Entscheide
D1a/D5a, 27.08.2026). **Reine Portal-Arbeit — kein Endpunkt, keine Migration,
kein Feld auf dem Draht**; sie behebt die zwei gemeldeten Defekte, ohne dem
Rahmen (Stufe 1) vorzugreifen.

- **Drei Rückwege übereinander wurden EINER.** Der Knopf „Anlage {Name}", die
  Reiter-Leiste des Bereichs (in der die Seite gar nicht vorkommt, also war
  KEIN Reiter aktiv) und der Link „Zurück zu den Komponenten" sind entfallen;
  übrig ist die Brotkrume `Anlage › Komponenten › {Gerät}`. `tabsFor` schweigt
  für `geraet`/`box` — sie wohnen im Bereich „Anlage" (damit die Seitenleiste
  ihren Wirt hervorhebt), stehen aber eine Ebene DARUNTER und zeigen EIN Gerät.
- **⚠ Die Messbibliothek fragte die BOX, nicht das Gerät.** `availableFamilies`
  ist server-seitig die Familien-VEREINIGUNG aller komponierten Punkte einer Box
  — praktisch die Familie des primären Wechselrichters, auf JEDER Geräteseite;
  die Wallbox zeigte damit `hybrid_3p`-Register. Der TRANSPORT bleibt die Box
  (dort wohnt die Selektion, Server und Edge sind unberührt), die ANZEIGE
  schneidet `?family=` auf das Gerät. Regeln, Ehrlichkeitssätze und der
  Katalog-Kopier-Wächter: `frontend/portal/AGENTS.md` „Geräteseiten Stufe 0".
- **⚠ Ehrliche Grenze, die bleibt, bis Stufe 3c ausgeliefert ist:** die Box
  pollt jeden beobachteten Punkt gegen `inverter.connection`, liest also nur
  über den PRIMÄREN Wechselrichter (plus OCPP über den Core). Jede andere
  Geräteseite SAGT das, statt einen Punkt anzunehmen, der gegen die falsche
  Adresse gelesen würde.

