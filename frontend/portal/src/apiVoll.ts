import {
  api as einstieg, API_BASE, ApiError, bereichKopf, gemerkteAnfrage, mitKennung, protokollFrage, request,
} from './api';
import type {
  Ablesung, AblesungAntwort, Abweichung, AbweichungEintragNeu, AbweichungErgebnis, AbweichungListe, AbweichungNeu,
  AnlageUmzug, AnlageUmzugAnfrage, AnlagensteuerungVerlauf, AnlagensteuerungWerte, Auffaelligkeit,
  AuffaelligkeitAntwort, AuffaelligkeitListe, AuffaelligkeitenAlle, BerechneteMessstelleAnlegen, Bericht,
  BerichtAnlegen, BerichtAnstoss, BerichtDetail, BerichtEntwurf, BerichtStand, BerichtStrukturAnlass,
  BerichtVergleich, BerichteBetroffen, BewertungKriterienFassung, BewertungKriterienSpeichern,
  BewertungMessabdeckung, BewertungRangliste, BewertungUmfang, BewertungUmfangSpeichern, BezugsKanalAnfrage,
  BezugsKanalAuswahl, BezugsKanalbindung, Bezugsbasis, BezugsbasisEntwurf, BezugsbasisFassung,
  BezugsdatenImportErgebnis, BezugsdatenImportProtokollEintrag, BezugsdatenRuecknahmeVorschau, BezugsdatenVorlage,
  BezugsdatenVorschau, BezugsdatenZuordnung, Bezugsflaechen, Bezugsgroesse, BezugsgroesseAnfrage,
  BezugsgroesseStammdatum, BezugsgroesseWerte, BezugsgroessenListe, BezugswertAntwort, BilanzRestAngelegt,
  BoxTauschAntwort, CommandHistory, ComponentDefinition, ComponentTemplate, ConsumerSchedule,
  ControllerwechselVorschau, CreateMeasurementPointInput, CreateSiteInput, Device, DevicePurgeResult, Earnings,
  EarningsRange, EdgeVersion, EinheitGeraet, Einspeiseverguetung, EinstellungEingetragen, EinstellungNeu,
  Energieeinsatz, EnergieeinsatzAenderung, EnergieeinsatzAnlegen, EnergieeinsatzBearbeiten, EnergieeinsatzEinfluss,
  EnergieeinsatzEinstufungFassung, EnergieeinsatzEinstufungHistorie, EnergieeinsatzEinstufungSpeichern,
  EnergieeinsatzVorschlag, EnergiemanagementAufgabeBeenden, EnergiemanagementAufgabeZuordnen,
  EnergiemanagementAufgaben, EnergiemanagementAufheben, EnergiemanagementBekanntmachen, EnergiemanagementDokument,
  EnergiemanagementDokumentAnlegen, EnergiemanagementDokumentKurz, EnergiemanagementEntscheid,
  EnergiemanagementFassungEntwerfen, EnergiemanagementGeprueft, EnergiemanagementLeitung, EnergiemanagementMappe,
  EnergiemanagementMappeAnlegen, EnergiemanagementNachweiseAmEinsatz, EnergiemanagementNachweiseDerPerson,
  EnergiemanagementPerson, EnergiemanagementPersonAendern, EnergiemanagementPersonAnlegen,
  EnergiemanagementPersonMitVerlauf, EnergiemanagementTeilVermerk, EnergiemanagementTeilVermerkAnlegen,
  EnergiemanagementTeilVermerke, EnergiemanagementVerantwortung, EnergiemanagementVergleich,
  EnergiemanagementVerzeichnis, EnergiemanagementVerzeichnisFilter, EnergiemanagementZuordnung, Energieziel,
  EnergiezielBewertungSchritt, EnergiezielErgebnis, EnergiezielListe, EnergiezielNeu, EnergiezielStand,
  EnergiezielZustand, EntityEnergy, ErsatzwertEingabe, ErsatzwertLuecke, ErsatzwertVorschau, Erzeugungseinheit,
  ErzeugungseinheitAendern, FaktorenVorschlag, FeststellungEintragFesthalten, FeststellungErfassen,
  FeststellungListe, FeststellungMitVerlauf, FeststellungStandFesthalten, ForecastQuality, FunktionMessenErgebnis,
  FunktionSteuernAnfrage, FunktionSteuernErgebnis, FunktionSteuernPruefung, GeraetEinstellungen, GeraetRolle,
  GeraetSummenwert, HistoryRange, InternesAuditAbschliessen, InternesAuditMitVerlauf, InternesAuditStand,
  InternesAuditprogramm, InterventionOutcome, Kennzahl, KennzahlAnfrage, KennzahlEingang, KennzahlFassung,
  KennzahlPeriodeArt, KennzahlVorlagen, KennzahlVorschau, KennzahlWerte, KennzahlWerteHistorie, KomponentenEreignis,
  KorrekturDetail, Kostenstelle, KostenstelleEnergie, KostenstelleEnergiePeriode, KostenstelleProzessAnlegen,
  Managementbewertung, ManagementbewertungBeschlussFesthalten, ManagementbewertungFolgeVerknuepfen,
  ManagementbewertungSitzungFesthalten, Massnahme, MassnahmeAendern, MassnahmeBewertungSchritt, MassnahmeBewertungen,
  MassnahmeErgebnis, MassnahmeListe, MassnahmeNeu, MassnahmeSchaetzung, MassnahmeWirkung, MastrApplyInput,
  MastrLokationApplyInput, MastrLokationPreview, MastrPreview, MeasurementBudgetEstimate, MeasurementCatalogResult,
  MeasurementComparisonOption, MeasurementHistory, MeasurementPoint, MeasurementRange, MeasurementSelectionState,
  Messbedarf, MessbedarfAenderung, MessbedarfAnlegen, MesskanalListe, MessmittelAngaben, MessmittelEintrag,
  Messstelle, MessstelleAnlegen, MessstelleFormel, MessstelleFormelFassungEintragen, MessstelleOrtAendern,
  MessstelleProzesse, MessstelleQuelleBeenden, MessstelleQuelleBinden, MessstelleQuelleVorgang,
  MessstelleQuellenListe, MessstelleStellungAendern, MessstelleVerlauf, MessstelleVerteilung,
  MessstelleVorschlagUebernehmen, MessstelleVorschlagUebernommen, MessstelleVorschlagsliste, MessstelleWert,
  MessstelleWerte, MessstelleWerteHistorie, MessstelleWerteRaster, NetzVermarktung, NetzVermarktungAendern,
  Netzanschluesse, Netzanschluss, NetzanschlussAnfrage, NetzanschlussBinden, NetzanschlussGrenzNachweis,
  NetzanschlussUebernehmen, NetzanschlussVorschlag, NeueAnlageInput, OcppAction, OcppActionAudit, OcppActionInput,
  OcppActionIntent, OcppActionPermissions, OcppConfiguration, OcppDataGap, OcppProtocolEvent, OcppStation,
  OcppTransaction, OcppTransactionEconomics, Ort, OrtAnlegen, OrtBearbeiten, OrtFlaeche, OrtKurzzeichenVorschlag,
  OrtVerschiebenAnfrage, OrtVerschiebung, OrteSuchAntwort, OrtsbaumAmStichtag, PortfolioKpi, PriceHistory,
  PriceSeries, ProbeAntwort, Protokoll, ProtokollAbfrage, Prozess, ProzessMessstellen, RegisterAbgleich,
  RegisterEinheit, RegisterEinheitHinweis, RegisterKnowledgeFamily, RegisterWriteEvent, RegisterWriteInput,
  RegisterWriteOutcome, RegisterWriteTarget, RollenEingabe, RollenZuordnungAntwort, RueckblickResponse, RuleEvents,
  SaveBatteryInput, SaveComponentBody, SchaltTestAntwort, SelbstbauLeseAntwort, SichtbareListe, Site, SiteAsset,
  SiteComponentTemplate, SiteComponents, SiteDeletionPreview, SiteDetail, SiteScene, SiteTopology,
  StandortAmStichtag, StandortKurzzeichenVorschlag, StandortStammdaten, StandortWetter, StandortZuordnungBestaetigen,
  StandortZuordnungErgebnis, StandortZuordnungVorschau, SteuerlogikAngenommen, SteuerlogikBlatt, SteuerlogikKarte,
  SteuerlogikProtokoll, SteuerlogikSchritt, SteuerlogikVerlauf, SteuerlogikVorschau, SteuerungVorschau,
  SuggestionState, SuggestionStates, SummenwertKontext, SummenwertRolle, SupplyPrice, SupplyPriceUpdate, SzeneKey,
  TelemetryPoint, TopologyRoleAssignment, UemsBetreiberblatt, UemsDatenquelle, UemsDatenquelleAnlegen,
  UemsDatenquelleBearbeiten, UemsDatenquelleBestaetigt, UemsDatenquellePruefergebnis, UemsDatenquelleUebernommen,
  UemsDatenquelleVorschlagsliste, UemsDatenquellenListe, UemsGemeinsameSteuerungEinrichten,
  UemsGemeinsameSteuerungSetzen, UemsGemeinsameSteuerungZustand, UemsGeraet, UemsSprungprobe, UemsSteckerprobe,
  UemsSteuerRichtung, UnternehmenVierAugen, UpdateDeviceInput, VariablenVorschlag, VergleichToleranzFassung,
  Versorgung, VerteilungZeileEingabe, VorgangAnstossAntwort, VorschauKnoepfe, WagoGeraeteangaben, WagoKartenAnlage,
  WagoKartenangaben, WagoKartenwechsel, WagoSollLesung, Wetterbezug, WetterbezugAnfrage, Zaehlerwechsel,
  ZaehlerwechselVorgang,
  LogikAnsicht, LogikBericht, LogikGeprueft, LogikGespeichert, LogikListe, LogikQuellen, LogikZustand,
  BausteinEingesetzt, BausteinFuellung, BausteinListe, BausteinLuecke, BausteinSatzTeil,
} from './api';
import { freshToken } from './auth';
import type { BezugsbasisUebersicht, BezugsbasisZustand } from './bezugsbasisUebersicht';
import type { BezugsbasisVergleich, BezugsbasisVergleichWahl } from './bezugsbasisVergleich';
import type { BezugsgroesseLesart } from './bezugsgroesse';
import type {
  CockpitLayoutDocument, CockpitLayoutLayer, CockpitLayoutResponse, Flaeche as CockpitLayoutFlaeche,
} from './cockpitLayout';
import type { FahrzeugWunsch, SiteFahrzeuge } from './fahrzeugProfile';
import type { Geraetesuche, GeraetesucheVerlaufEintrag } from './geraetesuche';
import type { ComponentMatch } from './komponentenAssistent';
import type { ChargingBoostResult, ChargingConfig, StoragePriority, SurplusPolicy } from './ladepunkte';
import type { ProfileState, SiteProfiles } from './profiles';
import type { ModellWahlZustand } from './prognose';
import type { SimulationRequestInput, SimulationStatus } from './simulation';
import type { SteuerartErgebnis, SteuerartWunsch } from './steuerartDialog';
import type { VerbesserungUebersicht } from './verbesserungUebersicht';
import type { SiteVerbraucher } from './verbraucherZone';
import type { Wiedervorlage, WiedervorlageZuletzt } from './wiedervorlage';

/**
 * DAS VOLLE `api`-OBJEKT (Performance Welle 3; erledigt die Folgeaufgabe `vp-portal-einstieg-folge-api-teilung`).
 *
 * `api.ts` liegt im Einstiegs-Bündel und trug alle rund 500 Routen, obwohl das erste Bild (Schale, Anlagen-Cockpit,
 * Start-Abrufe) nur gut 40 davon ruft. Ein Objekt-Literal beschneidet Rollup nicht: jede Route kam bei jedem Aufruf
 * mit. Die übrigen Routen stehen jetzt hier und hängen sich beim Laden dieses Moduls an DASSELBE Objekt (`api` aus
 * `api.ts`): jeder Aufrufer und jedes `vi.spyOn(api, …)` sehen weiter das eine Objekt.
 *
 * ⚠ Die Grenze hält der TYP, nicht eine Liste: `api` aus `api.ts` kennt nur die Routen des Einstiegs. Wer eine der
 * Routen hier ruft, importiert `api` von hier (`import { api } from './apiVoll'`) - damit lädt jedes Stück, das sie
 * braucht, dieses Modul vor sich (statischer Import), und ein Aufruf über `api.ts` ist ein Typfehler statt eines
 * Laufzeitfehlers. Braucht der Einstieg eine Route von hier, zieht sie nach `api.ts` um (sonst käme dieses ganze
 * Modul mit dem ersten Bild). Bündel-Wächter: `test/bundle-smoke.sh`, schneller Zwilling `src/einstiegLuft.test.ts`.
 */

const weitere = {
  korrekturen: (standortId: string) => request<KorrekturDetail[]>(`/api/v1/standorte/${encodeURIComponent(standortId)}/korrekturen`),
  korrektur: (kennung: string) => request<KorrekturDetail>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}`),
  ersatzwertLuecken: (kennzeichen: string, quelle_id: string, von: string, bis: string) => request<ErsatzwertLuecke[]>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte/luecken?${new URLSearchParams({ quelle_id, von, bis })}`),
  ersatzwertVorschau: (kennzeichen: string, eingabe: ErsatzwertEingabe) => request<ErsatzwertVorschau>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte/vorschau`, { method: 'POST', body: JSON.stringify(eingabe) }),
  ersatzwertErfassen: (kennzeichen: string, eingabe: ErsatzwertEingabe) => request<KorrekturDetail>(`/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/ersatzwerte`, { method: 'POST', body: JSON.stringify(eingabe) }),
  korrekturFreigeben: (kennung: string, begruendung: string) => request<unknown>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/freigeben`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  korrekturAblehnen: (kennung: string, grund: string) => request<KorrekturDetail>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/ablehnen`, { method: 'POST', body: JSON.stringify({ grund }) }),
  korrekturZuruecknehmen: (kennung: string, grund: string) => request<unknown>(`/api/v1/korrekturen/${encodeURIComponent(kennung)}/zuruecknehmen`, { method: 'POST', body: JSON.stringify({ grund }) }),
  ersatzwertZuruecknehmen: (kennung: string, grund: string) => request<{ kennung: string; status: string; fassung: number; korrektur: string | null }>(`/api/v1/ersatzwerte/${encodeURIComponent(kennung)}/zuruecknehmen`, { method: 'POST', body: JSON.stringify({ grund }) }),
  /** Portfolio-Kennzahlen des UEMS-Kachelrasters (Leitkennzahl, Verbrauch, Lastspitze, Kosten). */
  portfolioKpis: () => request<PortfolioKpi>('/api/v1/portfolio/kpis'),
  /**
   * Der gemeldete Edge-Stand aller Geräte des Mandanten (Plattform-Übersicht).
   * Eine leere Liste heißt „kein Gerät hat je gemeldet", nicht „alle aktuell".
   */
  edgeVersions: () => request<SichtbareListe<EdgeVersion>>('/api/v1/edge-versions'),
  /**
   * ⚠ `entityId` schneidet Auswahl und Papier-Spur auf EINE Komponente dieses
   * Geraets (Stufe 3b). Es ist ueberall OPTIONAL: ohne es antwortet der Server
   * wie vorher ueber das ganze Geraet, also bleibt jeder Bestands-Aufrufer
   * Zeichen fuer Zeichen unveraendert.
   */
  measurementSelection: (deviceId: string, entityId?: string) =>
    request<MeasurementSelectionState>(
      `/api/v1/devices/${deviceId}/measurement-selection${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    ),
  summenwertQuellen: (siteId: string, kontext: SummenwertKontext = { art: 'anlage' }) =>
    request<Array<{ entityId: string; deviceId: string | null; name: string; grund: string | null }>>(`/api/v1/sites/${siteId}/summenwert-quellen${kontext.art === 'geraet' ? `?${new URLSearchParams({ boxId: kontext.boxId, geraetId: kontext.geraetId })}` : ''}`),

  /** Flüchtige Katalog-Lesung; verändert weder Selektion noch Register. */
  measurementLesen: (deviceId: string, entityId: string, pointKey: string) =>
    request<import('./summenwertQuellen').Sitzungswert>(
      `/api/v1/devices/${deviceId}/measurement-selection/lesen?${new URLSearchParams({ entityId, pointKey })}`,
      { method: 'POST' },
    ),

  measurementCatalog: (deviceId: string, params: URLSearchParams) =>
    request<MeasurementCatalogResult>(
      `/api/v1/devices/${deviceId}/measurement-selection/catalog?${params.toString()}`,
    ),
  measurementEstimate: (
    deviceId: string, pointKey: string, cadenceS: number, enabled: boolean, entityId?: string,
  ) => request<MeasurementBudgetEstimate>(
    `/api/v1/devices/${deviceId}/measurement-selection/estimate?pointKey=${encodeURIComponent(pointKey)}&enabled=${enabled}&cadenceS=${cadenceS}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`,
  ),
  changeMeasurementSelection: (
    deviceId: string,
    pointKey: string,
    body: { expectedRevision: number; idempotencyKey: string; enabled: boolean; cadenceS?: number },
    entityId?: string,
  ) => request<MeasurementSelectionState>(
    `/api/v1/devices/${deviceId}/measurement-selection/${encodeURIComponent(pointKey)}${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),
  addCustomMeasurement: (deviceId: string, body: Record<string, unknown>, entityId?: string) =>
    request<MeasurementSelectionState>(
      `/api/v1/devices/${deviceId}/measurement-selection/custom${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  customMeasurementEstimate: (
    deviceId: string, definition: Record<string, unknown>, entityId?: string,
  ) => request<MeasurementBudgetEstimate>(
    `/api/v1/devices/${deviceId}/measurement-selection/custom/estimate${entityId ? `?entityId=${encodeURIComponent(entityId)}` : ''}`,
    { method: 'POST', body: JSON.stringify(definition) },
  ),
  measurementHistory: (
    deviceId: string, pointKey: string, range: MeasurementRange,
    representation: 'raw' | 'decoded', from?: string, to?: string, siteId?: string,
    entityId?: string,
  ) => request<MeasurementHistory>(
    `/api/v1/devices/${deviceId}/measurement-selection/${encodeURIComponent(pointKey)}/history?range=${range}&representation=${representation}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`,
  ),
  measurementComparisonOptions: (siteId: string) =>
    request<MeasurementComparisonOption[]>(`/api/v1/sites/${siteId}/measurement-history/options`),
  /**
   * Realized earnings (measured, per site + totals) for a Berlin period. `at`
   * (ISO day) picks the period instance - e.g. a past month tapped in the
   * 12-month strip; omitted = the current period.
   */
  earnings: (range: EarningsRange = 'month', at?: string | null) =>
    request<Earnings>(
      `/api/v1/earnings?range=${range}${at ? `&at=${at}` : ''}`,
    ),
  ocppControl: (siteId: string) => request<import('./ocppControl').OcppControlView>(`/api/v1/sites/${siteId}/ocpp/control`),
  saveOcppControl: (siteId: string, policy: import('./ocppControl').OcppControlPolicy) =>
    request<import('./ocppControl').OcppControlView>(`/api/v1/sites/${siteId}/ocpp/control`, { method: 'PUT', body: JSON.stringify(policy) }),
  /**
   * Die Zone „Verbraucher" der Steuerungsseite (Konzept
   * `vp-verbrauchsmgmt-konzept-v1` §6, Paket P1) — EIN Lese-Aggregat: je
   * steuerbarer Komponente ihre STEUERART, der Anlagen-Standard der Ladepunkte
   * samt Ladepark-Rahmen, und die initiale Rangliste. Alles ist eine
   * PROJEKTION auf den Bestand (Policy, Quellen-Wahl der Box, Herzschlag,
   * aktive Flows) — es gibt hier bewusst KEINEN Schreibpfad.
   */
  siteVerbraucher: (siteId: string) =>
    request<SiteVerbraucher>(`/api/v1/sites/${siteId}/verbraucher`),
  /**
   * Die REIHENFOLGE bei knapper Leistung setzen (Paket P4, §5). Die Antwort ist
   * die Zone, wie sie danach GELESEN wird — also die Normalform; die Fläche
   * übernimmt sie, statt ihre eigene Anordnung stehen zu lassen.
   *
   * Gespeichert wird kein neues Format: der Server projiziert auf
   * `default_service_rank`, `storage_relation` und die Speicher-Frage des
   * Ladeparks.
   */
  saveRangliste: (siteId: string, eintraege: { art: string; entityId?: string }[]) =>
    request<SiteVerbraucher>(`/api/v1/sites/${siteId}/rangliste`, {
      method: 'PUT',
      body: JSON.stringify({ eintraege }),
    }),
  /**
   * Die Steuerart EINER Komponente setzen (Verbrauchsmanagement v1 P2).
   *
   * Der Rumpf ist die SPIEGELFORM der gelesenen Steuerart, damit der Rundlauf
   * hält: was hier hingeht, liest die Projektion danach wieder aus. Die
   * Antwort trägt die Steuerart, wie sie JETZT gilt — die Fläche rechnet sie
   * nie selbst aus.
   */
  setzeSteuerart: (siteId: string, entityId: string, wunsch: SteuerartWunsch) =>
    request<SteuerartErgebnis>(
      `/api/v1/sites/${siteId}/verbraucher/${entityId}/steuerart`,
      { method: 'PUT', body: JSON.stringify(wunsch) },
    ),
  /**
   * Die FAHRZEUGE einer Anlage (Verbrauchsmanagement v1 P7): je Ladekarte, die
   * hier geladen hat, eine Zeile - mit Namen und Steuerart, sobald der Kunde
   * sie vergeben hat.
   *
   * ⚠ Der Schlüssel ist der PSEUDONYM der Box, nie ein Klartext-IdTag - das
   * Portal bekommt ihn gar nicht zu sehen. Er ist auch NICHT der Bezug aus dem
   * OCPP-Journal (`OcppTransaction.startIdTagRef`): den pfeffert die Cloud ein
   * zweites Mal, dieselbe Karte trägt dort einen anderen Wert.
   */
  siteFahrzeuge: (siteId: string) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge`),
  setzeFahrzeug: (siteId: string, tagRef: string, wunsch: FahrzeugWunsch) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge/${encodeURIComponent(tagRef)}`,
      { method: 'PUT', body: JSON.stringify(wunsch) }),
  entferneFahrzeugProfil: (siteId: string, tagRef: string) =>
    request<SiteFahrzeuge>(`/api/v1/sites/${siteId}/fahrzeuge/${encodeURIComponent(tagRef)}`,
      { method: 'DELETE' }),
  /** Complete, tenant-scoped OCPP 1.6 station inventory for the device home. */
  ocppStations: (siteId: string, signal?: AbortSignal) =>
    request<OcppStation[]>(`/api/v1/sites/${siteId}/ocpp/stations`, { signal }),
  ocppEvents: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppProtocolEvent[]>(`/api/v1/sites/${siteId}/ocpp/events?limit=${limit}`, { signal }),
  ocppGaps: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppDataGap[]>(`/api/v1/sites/${siteId}/ocpp/gaps?limit=${limit}`, { signal }),
  ocppTransactions: (siteId: string, limit = 200, signal?: AbortSignal) =>
    request<OcppTransaction[]>(`/api/v1/sites/${siteId}/ocpp/transactions?limit=${limit}`, { signal }),
  /**
   * „Ladungen" mit Herkunft und Geld (Konzept „Ein Ort fürs Laden" e1,
   * Scheibe 2): alle Ladepunkte der Anlage, ein Kalendermonat
   * (`yyyy-MM`, Vorgabe der laufende Monat in Europe/Berlin).
   */
  ocppTransactionEconomics: (siteId: string, month?: string, signal?: AbortSignal) =>
    request<OcppTransactionEconomics[]>(
      `/api/v1/sites/${siteId}/ocpp/transactions/economics${month ? `?month=${encodeURIComponent(month)}` : ''}`,
      { signal },
    ),
  ocppConfiguration: (siteId: string, chargePointId: string, signal?: AbortSignal) =>
    request<OcppConfiguration[]>(
      `/api/v1/sites/${siteId}/ocpp/configuration?chargePointId=${encodeURIComponent(chargePointId)}`,
      { signal },
    ),
  ocppActionPermissions: (siteId: string, signal?: AbortSignal) =>
    request<OcppActionPermissions>(`/api/v1/sites/${siteId}/ocpp/action-permissions`, { signal }),
  ocppActions: (siteId: string, chargePointId: string, limit = 100, signal?: AbortSignal) =>
    request<OcppAction[]>(
      `/api/v1/sites/${siteId}/ocpp/actions?chargePointId=${encodeURIComponent(chargePointId)}&limit=${limit}`,
      { signal },
    ),
  createOcppActionIntent: (
    siteId: string,
    chargePointId: string,
    body: Pick<OcppActionInput, 'action' | 'connectorId' | 'transactionId' | 'request'>,
  ) => request<OcppActionIntent>(
    `/api/v1/sites/${siteId}/ocpp/stations/${encodeURIComponent(chargePointId)}/action-intents`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
  createOcppAction: (
    siteId: string,
    chargePointId: string,
    body: OcppActionInput,
    idempotencyKey: string,
  ) => request<OcppAction>(
    `/api/v1/sites/${siteId}/ocpp/stations/${encodeURIComponent(chargePointId)}/actions`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    },
  ),
  ocppAction: (siteId: string, actionId: string, signal?: AbortSignal) =>
    request<OcppAction>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}`, { signal }),
  ocppActionAudit: (siteId: string, actionId: string, signal?: AbortSignal) =>
    request<OcppActionAudit[]>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}/audit`, { signal }),
  cancelOcppAction: (siteId: string, actionId: string) =>
    request<void>(`/api/v1/sites/${siteId}/ocpp/actions/${actionId}`, { method: 'DELETE' }),
  /** „Speicher jetzt laden" / „Ladestand halten" - Dauer ist PFLICHT. */
  startBatteryOverride: (
    siteId: string,
    body: { kind: 'speicher_laden' | 'speicher_halten'; durationMinutes?: number;
      endsAt?: string; setpointKw?: number },
  ) => request<InterventionOutcome>(`/api/v1/sites/${siteId}/battery-override`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  /** „Automatik fortsetzen" für den Speicher. */
  clearBatteryOverride: (siteId: string) =>
    request<InterventionOutcome>(`/api/v1/sites/${siteId}/battery-override`, {
      method: 'DELETE',
    }),
  /** „Automatik pausieren" - Fahrplan UND Regeln ruhen für die Dauer. */
  pauseAutomation: (
    siteId: string,
    body: { durationMinutes?: number; endsAt?: string },
  ) => request<InterventionOutcome>(`/api/v1/sites/${siteId}/automation-pause`, {
    method: 'POST', body: JSON.stringify({ kind: 'pause', ...body }),
  }),
  /** „Automatik fortsetzen" für die ganze Anlage. */
  resumeAutomation: (siteId: string) =>
    request<InterventionOutcome>(`/api/v1/sites/${siteId}/automation-pause`, {
      method: 'DELETE',
    }),
  /**
   * Das GEDÄCHTNIS der Vorschläge (Steuerung Stufe 6): welche der abgeleiteten
   * Karten der Kunde gerade nicht sehen will.
   *
   * ⚠ Es gibt bewusst KEINE Route, die Vorschläge LIEFERT - sie sind eine
   * Ableitung aus dem Fahrplan (`vorschlaege.ts`), und eine Server-Route müsste
   * dieselbe Ableitung ein zweites Mal führen. Abgelaufene Haltungen kommen
   * hier gar nicht erst an.
   */
  /**
   * Die Vorschau EINER Entscheidung (Steuerung Stufe 7): zwei echte
   * Solver-Läufe über eine Eingabe, und die Differenz ihres Netto-Vorteils.
   *
   * ⚠ Sie ist TEUER (ein MILP-Lauf) und gedeckelt - die Fläche fragt sie
   * einmal je geöffneter Folgen-Karte, nie in einer Schleife.
   */
  steuerungVorschau: (siteId: string, knoepfe: VorschauKnoepfe) =>
    request<SteuerungVorschau>(`/api/v1/sites/${siteId}/steuerung-vorschau`, {
      method: 'POST', body: JSON.stringify(knoepfe),
    }),
  suggestionStates: (siteId: string) =>
    request<SuggestionStates>(`/api/v1/sites/${siteId}/suggestion-states`),
  /**
   * „Später" (ein Tag) oder „Ablehnen" (sieben Tage). Die FRIST rechnet der
   * Server - eine vom Client gewählte Dauer wäre ein Weg, einen Vorschlag für
   * immer verstummen zu lassen, ohne ihn je abzulehnen.
   */
  setSuggestionState: (siteId: string, key: string, state: SuggestionState['state']) =>
    request<SuggestionState>(
      `/api/v1/sites/${siteId}/suggestion-states/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ state }) },
    ),
  /** Eine Haltung zurücknehmen (etwa „nur messen"); idempotent. */
  clearSuggestionState: (siteId: string, key: string) =>
    request<void>(
      `/api/v1/sites/${siteId}/suggestion-states/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),
  /** Die laufende Szene der Anlage (`scene: null` = keine). */
  scene: (siteId: string) => request<SiteScene>(`/api/v1/sites/${siteId}/scene`),
  /** Eine Szene einschalten: pausiert die gewählten Geräte, bis sie endet. */
  startScene: (siteId: string, key: SzeneKey, entityIds: string[]) =>
    request<SiteScene>(`/api/v1/sites/${siteId}/scene`, {
      method: 'PUT', body: JSON.stringify({ key, entityIds }),
    }),
  /** Die Szene beenden - setzt genau die Geräte fort, die sie pausiert hat. */
  endScene: (siteId: string) =>
    request<SiteScene>(`/api/v1/sites/${siteId}/scene`, { method: 'DELETE' }),
  /** Die im Portal gepflegte Anschlussgrenze + Vorrang-Wahl. */
  chargingConfig: (siteId: string) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config`),
  /**
   * Speichert Anschlussgrenze und/oder Vorrang - PATCH-Semantik: ein NICHT
   * übergebenes Feld behält seinen Wert (ein Dialog, der nur den Vorrang
   * stellt, darf die Grenze nicht löschen).
   */
  saveChargingConfig: (
    siteId: string,
    body: {
      gridLimitKw?: number;
      priorityChargePointIds?: string[];
      // Die QUELLEN-Wahl (Stufe 4). Sie ändert KEINE Grenze - die zwei Bahnen
      // komponieren most-restrictive-wins. Nicht übergeben = unverändert, was
      // NICHT dasselbe ist wie `schnell` (eine eigene Aussage des Kunden).
      surplusPolicy?: SurplusPolicy;
      storagePriority?: StoragePriority;
    },
  ) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Kunden-Schritt „Grenze“ (AP-01 IP-13): der Server prüft die heute
   * gebundene vereinbarte Leistung und das verbleibende Ladebudget. Der
   * Übergangswert ist nur nötig, solange kein Netzanschluss gebunden ist.
   */
  saveCustomerChargingFrame: (
    siteId: string,
    body: { gridLimitKw: number; vereinbartKw?: number },
  ) => request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-frame`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  /**
   * „Sonne + Speicher“: die Reserve der Anlage in kWh. `null` nimmt die eigene
   * Angabe zurück - dann gilt die Vorgabe des Optimierers.
   */
  saveStorageReleaseReserve: (siteId: string, reserveKwh: number | null) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config/storage-release`, {
      method: 'PUT',
      body: JSON.stringify({ reserveKwh }),
    }),
  /**
   * Speichert den Ladepark-RAHMEN (P5/E10) — Plattform-Admin only.
   *
   * ⚠ PATCH-Semantik in BEIDE Richtungen: ein NICHT übergebenes Feld behält
   * seinen gespeicherten Wert, ein ausdrückliches `null` LÖSCHT es (und die Box
   * behält dann wieder ihre eigene Zahl). Deshalb sind die Werte `| null` und
   * nicht bloß optional — „nichts sagen" und „zurücknehmen" sind zwei
   * verschiedene Handlungen.
   */
  saveChargingFrame: (
    siteId: string,
    body: {
      houseReserveKw?: number | null;
      marginPct?: number | null;
      minPowerKw?: number | null;
      rotationMinutes?: number | null;
      maxHouseLoadKw?: number | null;
      staticBudget?: boolean | null;
    },
  ) =>
    request<ChargingConfig>(`/api/v1/admin/sites/${siteId}/charging-frame`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Trägt EINE Ladesäule in die Allowlist ein (Anbinde-Assistent, Schritt 1).
   *
   * ⚠ Es ist ein POST, kein PUT, und das ist die Aussage: die Liste fügt nur
   * hinzu. Einen Eintrag zu ENTFERNEN würfe die Säule beim nächsten
   * Verbindungsaufbau vom Broker - das bleibt eine ausdrückliche Handlung am
   * Gerät. Dieselbe Kennung erneut ist ein No-op, das nur auffrischt.
   */
  admitChargePoint: (
    siteId: string,
    body: {
      chargePointId: string;
      label?: string;
      ratedKw?: number;
      connectors?: number;
      /**
       * WO die Säule hängt (Cockpit Phase 1 / C1). Weggelassen heisst „dazu
       * wird nichts gesagt" - die Box behält dann, was sie hat.
       */
      connection?: 'haus' | 'eigen';
      /** Die Box, deren echte Adresse der Anbinde-Assistent zeigt. */
      deviceId?: string;
    },
  ) =>
    request<ChargingConfig>(`/api/v1/sites/${siteId}/charging-config/charge-points`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Nimmt EINE eingetragene Ladepunkt-Kennung zurück.
   *
   * ⚠ Es ist ein DELETE auf GENAU EINE Kennung, nie ein Setzen der ganzen
   * Liste: die Rücknahme hat Folgen für eine laufende Anlage (die Säule wird
   * getrennt und ein Wiederverbinden abgewiesen), und die soll niemand als
   * Nebenwirkung eines Speicherns auslösen können. Sie reist als GRABSTEIN in
   * jedem folgenden Dokument an die Box mit, bis die Kennung wieder eingetragen
   * wird - ein blosses Weglassen wäre kein Löschen.
   */
  removeChargePoint: (siteId: string, chargePointId: string) =>
    request<ChargingConfig>(
      `/api/v1/sites/${siteId}/charging-config/charge-points/${encodeURIComponent(chargePointId)}`,
      { method: 'DELETE' },
    ),
  /**
   * Der Handeingriff an EINEM laufenden Ladevorgang, in zwei Richtungen:
   * „Jetzt voll laden" (von der Überschuss-Priorität ausgenommen, Netzstrom
   * erlaubt) und sein Geschwister „Laden pausieren" (P3b, Deckel 0).
   *
   * ⚠ BEIDES ist KEINE Grenze: Anschlussgrenze, Sicherheitsabstand, §14a und
   * der Ausfall-Schutz binden unverändert, und ALLE ANDEREN Ladevorgänge
   * bleiben, wie sie sind. `cancel: true` nimmt beide Richtungen zurück.
   */
  chargingBoost: (
    siteId: string,
    body: {
      chargePointId: string;
      connectorId: number;
      minutes?: number;
      cancel?: boolean;
      /**
       * Die RICHTUNG (P3b, Entscheid E5): `voll` (Vorgabe) oder `pause`
       * („Laden pausieren"). Abwesend = `voll`, also ist ein Aufruf ohne das
       * Feld zeichengleich wie vorher.
       */
      action?: 'voll' | 'pause';
      /**
       * „Bis Abstecken" (Audit W-10): `minutes` zählt dann nicht, die Box hält
       * bis zum Ende der Sitzung mit ihrem Deckel für diesen Fall (14 h).
       * Abwesend = das Verhalten von vorher (ohne Minuten 4 h).
       */
      untilUnplug?: boolean;
    },
  ) =>
    request<ChargingBoostResult>(`/api/v1/sites/${siteId}/charging-boost`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Das REGEL-PROTOKOLL der Anlage (Einheitsmodell Stufe 5b): Zähler je Regel,
   * Verlauf je Regel und das kompakte Gesamt-Protokoll in EINER Antwort - die
   * Fläche lädt es einmal und bedient daraus alle drei Orte. Ein älteres
   * Backend kennt die Route nicht; der Aufrufer holt sie deshalb fail-soft.
   */
  siteRuleEvents: (siteId: string) =>
    request<RuleEvents>(`/api/v1/sites/${siteId}/rule-events`),
  /**
   * Der KOMMANDO-VERLAUF (Kommando-Transparenz V1): der Zeitraum EINER
   * Komponente - oder der ganzen Anlage, wenn keine gewählt ist. Ein älteres
   * Backend kennt die Route nicht; der Aufrufer holt sie deshalb fail-soft.
   */
  commandHistory: (
    siteId: string,
    opts: {
      entity?: string | null;
      /**
       * Das GERÄT (Anlagen-Zentrale Stufe 1): die Referenz der Box, eine
       * gemeldete Quellen-Kennung oder `cp-<ChargePointId>`. Schliesst
       * `entity` aus - der Server antwortet auf beides mit 400.
       */
      device?: string | null;
      range?: 'day' | 'week' | 'month';
      at?: string | null;
      /** Ein eigener Zeitraum (Kalendertage) - schliesst `range`/`at` aus. */
      from?: string | null;
      to?: string | null;
      /**
       * Die drei STRUKTUR-Filter (Geräteseiten Revision B §6), komma-getrennt.
       * Ein Wort ausserhalb des Server-Vokabulars ist eine benannte 400 - das
       * Portal schickt deshalb nur Werte aus dem hier notierten Vokabular.
       */
      streams?: string | null;
      sources?: string | null;
      verdicts?: string | null;
      limit?: number | null;
      /** Der Seiten-Cursor: „bis zu diesem Zeitpunkt" (ISO). */
      before?: string | null;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.from && opts.to) {
      q.set('from', opts.from);
      q.set('to', opts.to);
    } else {
      q.set('range', opts.range ?? 'day');
      if (opts.at) q.set('at', opts.at);
    }
    if (opts.entity) q.set('entity', opts.entity);
    else if (opts.device) q.set('device', opts.device);
    if (opts.streams) q.set('streams', opts.streams);
    if (opts.sources) q.set('sources', opts.sources);
    if (opts.verdicts) q.set('verdicts', opts.verdicts);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    return request<CommandHistory>(`/api/v1/sites/${siteId}/command-history?${q}`);
  },
  /**
   * Verbraucher-Slots des jüngsten Co-Optimizer-Laufs für den Fahrplan-Layer
   * (Inkrement 2, SHADOW). Leeres Dokument = der Normalzustand einer nicht
   * geflaggten Anlage - der Fahrplan bleibt dann unverändert.
   */
  consumerSchedule: (siteId: string) =>
    request<ConsumerSchedule>(`/api/v1/sites/${siteId}/consumer-schedule`),
  siteDetail: (siteId: string) => request<SiteDetail>(`/api/v1/sites/${siteId}`),
  /** `anfrageKennung`: dieselbe Kennung legt nie doppelt an (B3, Anlage-Flow a1). */
  createSite: (input: NeueAnlageInput, anfrageKennung?: string) =>
    request<Site>('/api/v1/sites', {
      method: 'POST',
      body: JSON.stringify(input),
      ...mitKennung(anfrageKennung),
    }),
  updateSite: (siteId: string, input: CreateSiteInput) =>
    request<Site>(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** The site's structured supply-price sheet (Bezugspreis-Komponenten). */
  supplyPrice: (siteId: string) =>
    request<SupplyPrice>(`/api/v1/sites/${siteId}/supply-price`),
  /** Upsert the supply-price sheet (PATCH semantics; see SupplyPriceUpdate). */
  updateSupplyPrice: (siteId: string, patch: SupplyPriceUpdate) =>
    request<SupplyPrice>(`/api/v1/sites/${siteId}/supply-price`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  /** Die Karte „Einspeisevergütung": der wirksame Satz mit Herkunft. */
  einspeiseverguetung: (siteId: string) =>
    request<Einspeiseverguetung>(`/api/v1/sites/${siteId}/einspeiseverguetung`),
  /**
   * Eigenen Satz setzen (ct/kWh) oder mit `null` auf die Herleitung zurücksetzen.
   * Ohne Inbetriebnahmedatum braucht ein Satz die Antwort zu § 51a
   * (`inbetriebnahmeAbSolarspitzengesetz`: in Betrieb ab dem 25.02.2025?).
   */
  setEinspeiseverguetung: (siteId: string, satzCtKwh: number | null, inbetriebnahmeAbSolarspitzengesetz?: boolean | null) =>
    request<Einspeiseverguetung>(`/api/v1/sites/${siteId}/einspeiseverguetung`, {
      method: 'PUT',
      body: JSON.stringify(
        inbetriebnahmeAbSolarspitzengesetz == null ? { satzCtKwh } : { satzCtKwh, inbetriebnahmeAbSolarspitzengesetz },
      ),
    }),
  /** 409 while the site still has devices (remove them first). */
  deleteSite: (siteId: string) =>
    request<void>(`/api/v1/sites/${siteId}`, { method: 'DELETE' }),
  siteDeletionPreview: (siteId: string) =>
    request<SiteDeletionPreview>(`/api/v1/sites/${siteId}/deletion-preview`),
  /**
   * `anfrageKennung`: ein Wiederholen nach verlorener Antwort bekommt die erste Antwort (Anlage-Flow
   * a1, Paket 2). `ersetzt`: Box verbinden S4 ("Andere Kennung", E4 = A) - die ID einer nie
   * gemeldeten Box, die der Server in derselben Transaktion löst, bevor er diese Kennung verbindet
   * (Vertrag Abschnitt 3.5); scheitert das Verbinden, bleibt sie unberührt.
   */
  claimDevice: (siteId: string, externalRef: string, anfrageKennung?: string, ersetzt?: string) =>
    request<Device>('/api/v1/devices/claim', {
      method: 'POST',
      body: JSON.stringify(ersetzt ? { siteId, externalRef, ersetzt } : { siteId, externalRef }),
      ...mitKennung(anfrageKennung),
    }),
  boxTauschen: (newId: string, oldId: string) =>
    request<BoxTauschAntwort>(`/api/v1/devices/${newId}/succeed/${oldId}`, { method: 'POST' }),
  updateDevice: (deviceId: string, input: UpdateDeviceInput) =>
    request<Device>(`/api/v1/devices/${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Unclaim: deletes the device and its telemetry; the ref becomes claimable again. */
  deleteDevice: (deviceId: string) =>
    request<void>(`/api/v1/devices/${deviceId}`, { method: 'DELETE' }),
  /**
   * Purge all recorded data of a device WITHOUT unclaiming it: telemetry and
   * derived aggregates are gone, the device stays connected, new data flows
   * normally. Irreversible.
   */
  purgeDeviceData: (deviceId: string) =>
    request<DevicePurgeResult>(`/api/v1/devices/${deviceId}/purge-data`, { method: 'POST' }),
  telemetry: (siteId: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return request<TelemetryPoint[]>(`/api/v1/sites/${siteId}/telemetry${qs ? `?${qs}` : ''}`);
  },
  siteAssets: (siteId: string) => request<SiteAsset[]>(`/api/v1/sites/${siteId}/assets`),
  /** A site's additional read-only Erzeuger measurement points (multi-source). */
  measurementPoints: (siteId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`),
  /** Record an additional Erzeuger source; returns the site's points afterwards. */
  addMeasurementPoint: (siteId: string, input: CreateMeasurementPointInput) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Remove an additional source; returns the site's remaining points. */
  deleteMeasurementPoint: (siteId: string, pointId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points/${pointId}`, {
      method: 'DELETE',
    }),
  /**
   * Die Geräte-Vorlagen, aus denen der Anlege-Assistent seine Auswahl rendert
   * (Einheitsmodell Stufe 0a/1). Authentifiziert, nicht anlagenbezogen - eine
   * Vorlage ist eine Aussage über ein PRODUKT.
   */
  componentTemplates: () => request<ComponentTemplate[]>('/api/v1/component-templates'),
  componentTemplate: (templateRef: string) =>
    request<ComponentTemplate>(`/api/v1/component-templates/${encodeURIComponent(templateRef)}`),
  /**
   * „Geräte suchen" (OpenAPI-Tag `geraetesuche`, docs/contracts/v2/mqtt-geraetesuche.md §7): startet auf der Box
   * einen lesenden Suchlauf im Heimnetz. Netze, Ports und Dauer bestimmt allein die Box; der Körper nennt nur die
   * Box. 409 `laeuft_schon`/`nicht_unterstuetzt`/`box_offline`, 429 `zu_oft` - der Körper der Ablehnung ist ein
   * `GeraetesucheFehler` (`ApiError.body`).
   */
  geraetesucheStarten: (siteId: string, deviceId: string, kennung: string) =>
    request<Geraetesuche>(`/api/v1/sites/${siteId}/geraetesuche`, {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
      ...mitKennung(kennung),
    }),
  /** Eine Suche: solange sie läuft, fragt das Portal alle 2 s und hört danach auf. */
  geraetesuche: (siteId: string, suchId: string, signal?: AbortSignal) =>
    request<Geraetesuche>(`/api/v1/sites/${siteId}/geraetesuche/${suchId}`, { signal }),
  /** Abbrechen: die Funde bis dahin gelten; eine beendete Suche bleibt, wie sie ist. */
  geraetesucheAbbrechen: (siteId: string, suchId: string) =>
    request<Geraetesuche>(`/api/v1/sites/${siteId}/geraetesuche/${suchId}`, { method: 'DELETE' }),
  /** Die Suchen der letzten 30 Tage, jüngste zuerst; nur Zahlen je Gruppe, nie die Funde (DP-3 A). */
  geraetesucheVerlauf: (siteId: string, deviceId?: string | null, signal?: AbortSignal) =>
    request<{ suchen: GeraetesucheVerlaufEintrag[] }>(
      `/api/v1/sites/${siteId}/geraetesuche${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`,
      { signal },
    ),
  /** Die Komponenten einer Anlage samt Autoritäts- und Soll/Ist-Stand (Stufe 1). */
  siteComponents: (siteId: string) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components`),
  /**
   * „Verbindung testen": die BOX liest das noch nicht gespeicherte Gerät einmal.
   * Ein Erfolg hinterlegt zugleich den Beleg, ohne den nicht gespeichert wird
   * (die Verbindungstest-Pflicht) - deshalb ist es dieselbe Route, nicht zwei.
   */
  testComponentConnection: (
    siteId: string,
    body: {
      templateRef: string;
      templateVersion?: number;
      role?: string;
      connection: Record<string, unknown>;
      /** Gewählte Box für ein neues Gerät; ohne Wahl entscheidet die führende Box. */
      deviceId?: string;
      /** Bestehende Komponente: der Server wählt die ausführende Box und ergänzt Secrets. */
      entityId?: string;
    },
  ) =>
    request<ProbeAntwort>(`/api/v1/sites/${siteId}/component-test`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * „Kennen wir dieses Gerät schon?" - die verwaiste Komponente, die ein
   * Speichern ÜBERNEHMEN würde (Alias-Kontinuität, Live-Fall Herzogau).
   *
   * <p>Die Entscheidung fällt AUF DEM SERVER, mit derselben Regel, die
   * `createComponent` danach fährt; hier wird nichts nachgerechnet. `204` (kein
   * Treffer) kommt als `undefined` an und heißt „es entsteht eine neue
   * Komponente" - ein völlig normaler Ausgang, nie ein Fehler.
   */
  matchComponent: (
    siteId: string,
    body: { templateRef: string; role: string; connection: Record<string, unknown> },
  ) =>
    request<ComponentMatch | undefined>(`/api/v1/sites/${siteId}/component-match`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * „Auf ‚aus‘ stellen“ (Heizstab V1, HZ-5): die Box stellt an jedem Ausgang des Shelly „nach Stromausfall: aus“
   * ein - nur auf diesen Klick. Die Antwort trägt je Ausgang die danach gelesene Einstellung (`ausgaenge`).
   */
  nachStromausfallAus: (
    siteId: string,
    body: { templateRef: string; templateVersion?: number; connection: Record<string, unknown>; deviceId?: string; entityId?: string },
  ) =>
    request<ProbeAntwort>(`/api/v1/sites/${siteId}/component-nach-stromausfall-aus`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Komponente anlegen (422 ohne bestandenen Verbindungstest). */
  createComponent: (siteId: string, body: SaveComponentBody) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Verbindung ändern - eine NEUE Fassung; die alte bleibt abrufbar. */
  updateComponent: (siteId: string, entityId: string, body: SaveComponentBody) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/${entityId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Die Fassungen einer Komponente, neueste zuerst. */
  componentVersions: (siteId: string, entityId: string) =>
    request<ComponentDefinition[]>(`/api/v1/sites/${siteId}/components/${entityId}/versions`),
  /** Zurück auf eine frühere Fassung - der Ein-Klick-Weg aus einem falschen Soll. */
  rollbackComponent: (siteId: string, entityId: string, version: number, expectedRevision: number) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/${entityId}/versions/${version}/rollback`,
      { method: 'POST', body: JSON.stringify({ expectedRevision }) },
    ),
  /**
   * „Jetzt lesen" (Einheitsmodell Stufe 3): die BOX liest EINEN Messwert des
   * noch nicht gespeicherten Geräts einmal und antwortet mit Roh- UND
   * skaliertem Wert - der Moment, in dem ein Skalierungsfehler sichtbar wird.
   *
   * Ein Erfolg hinterlegt zugleich den Beleg, der das Speichern freigibt; er
   * hängt an der VERBINDUNG, nicht am Messwert, also erzwingt eine geänderte
   * Skalierung keine neue Lesung, eine geänderte Adresse sehr wohl.
   */
  readCustomComponent: (siteId: string, body: Record<string, unknown>) =>
    request<SelbstbauLeseAntwort>(`/api/v1/sites/${siteId}/components/custom/read`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Modbus-Gerät anlegen (Stufe 3). */
  createCustomComponent: (siteId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Gerät ändern - eine NEUE Fassung. */
  updateCustomComponent: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom/${entityId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Ein selbst definiertes Gerät entfernen - samt seinem Lese-Flow. */
  deleteCustomComponent: (siteId: string, entityId: string) =>
    request<SiteComponents>(`/api/v1/sites/${siteId}/components/custom/${entityId}`, {
      method: 'DELETE',
    }),
  /**
   * Der gefuehrte Schalt-Test (Einheitsmodell Stufe 4). Er schreibt EINMAL; die
   * Box armiert ihr automatisches Aus, BEVOR sie schreibt.
   */
  /**
   * Schritt 1 der Register-Strecke: den Ist-Wert LESEN. Schreibt nichts und
   * hinterlässt keine Spur.
   *
   * `tenantId` stampft den `X-Tenant-Id`-Kopf NUR für diesen Aufruf - die
   * Plattform-Geräteseite kennt den Mandanten der Zeile, und den globalen
   * Umschalter unter den Füßen des Admins zu verstellen wäre ein Seiteneffekt.
   */
  registerWritePreview: (siteId: string, body: RegisterWriteInput, tenantId?: string) =>
    request<RegisterWriteOutcome>(`/api/v1/sites/${siteId}/register-write/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
      ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    }),
  /** Schritt 2: der EINE Schreibvorgang - mit Beleg und Papier-Spur. */
  registerWrite: (siteId: string, body: RegisterWriteInput, tenantId?: string) =>
    request<RegisterWriteOutcome>(`/api/v1/sites/${siteId}/register-write`, {
      method: 'POST',
      body: JSON.stringify(body),
      ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    }),
  /** Schritt 0: WELCHE Geräte dieser Anlage als Ziel in Frage kommen. */
  registerWriteTargets: (siteId: string, tenantId?: string) =>
    request<RegisterWriteTarget[]>(`/api/v1/sites/${siteId}/register-write/targets`,
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
  /** Das kuratierte Register-Wissen - reine Anzeige, entscheidet nichts. */
  registerKnowledge: (siteId: string, tenantId?: string) =>
    request<RegisterKnowledgeFamily[]>(
      `/api/v1/sites/${siteId}/register-write/register-knowledge`,
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
  /** Der Verlauf - dieselben Zeilen, die die Befehle-Seite einmischt. */
  registerWriteHistory: (siteId: string, deviceId?: string, tenantId?: string) =>
    request<RegisterWriteEvent[]>(
      `/api/v1/sites/${siteId}/register-write/history`
        + (deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''),
      tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {},
    ),
  switchTest: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SchaltTestAntwort>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-test`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Bricht den laufenden Test ab und schreibt den Sicherheitswert sofort. */
  switchTestCancel: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SchaltTestAntwort>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-test/cancel`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Die Freigabe - nur mit bestandenem Test UND bestaetigter Wirkung. */
  releaseSwitch: (siteId: string, entityId: string, body: Record<string, unknown>) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-release`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Nimmt die Freigabe zurueck - das Geraet ist danach wieder ein Sensor. */
  revokeSwitch: (siteId: string, entityId: string) =>
    request<SiteComponents>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/switch-release`,
      { method: 'DELETE' },
    ),
  /** Die PRIVATEN Vorlagen dieser Anlage (kein Katalog, kein Teilen). */
  siteComponentTemplates: (siteId: string) =>
    request<SiteComponentTemplate[]>(`/api/v1/sites/${siteId}/component-templates`),
  /** „Duplizieren": aus einem Gerät wird eine private Vorlage dieser Anlage. */
  duplicateCustomComponent: (siteId: string, entityId: string, label?: string) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/components/custom/${entityId}/duplicate`,
      { method: 'POST', body: JSON.stringify({ label }) },
    ),
  /**
   * Eine eigene Vorlage umbenennen (Einheitsmodell Stufe 6). VOLLE Darstellung
   * von Name und Notiz: eine ausgelassene Notiz LÖSCHT sie, ein leerer Name
   * wird abgelehnt. Es entsteht KEINE neue Fassung - eine Vorlage IST ihr
   * Leseplan, und ein Name ändert daran nichts.
   */
  renameSiteComponentTemplate: (
    siteId: string,
    templateRef: string,
    body: { label: string; note?: string | null },
  ) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/component-templates/${encodeURIComponent(templateRef)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  /** Eine eigene Vorlage entfernen. Geräte, die daraus entstanden, bleiben. */
  deleteSiteComponentTemplate: (siteId: string, templateRef: string) =>
    request<SiteComponentTemplate[]>(
      `/api/v1/sites/${siteId}/component-templates/${encodeURIComponent(templateRef)}`,
      { method: 'DELETE' },
    ),
  /**
   * Customer capability→role assignment (U2 "Rollen & Zuordnung"): set roles for
   * the caller's own site (RLS-fenced); returns the recomputed read-model. A
   * role never widens control, so no extra gate. Admins go through the switcher.
   */
  setTopologyRoles: (siteId: string, assignments: TopologyRoleAssignment[]) =>
    request<SiteTopology>(`/api/v1/sites/${siteId}/topology-roles`, {
      method: 'PUT',
      body: JSON.stringify({ assignments }),
    }),
  /**
   * Switch one Anwendung on or off. Switching ON makes the SERVER enable
   * exactly that profile's gated node types for the site and seed its starter
   * flow; switching OFF deactivates its flows and closes those nodes again.
   * Returns the recomputed shelf.
   */
  setSiteProfile: (siteId: string, profile: string, state: ProfileState) =>
    request<SiteProfiles>(`/api/v1/sites/${siteId}/profiles`, {
      method: 'PUT',
      body: JSON.stringify({ profile, state }),
    }),
  /**
   * Die kunden-weite Schicht EINER Fläche: auf `cockpit` die Vorgabe „für alle
   * meine Anlagen" (E1), auf `portfolio` das Kunden-Cockpit selbst (Stufe 4) —
   * dort ist `eigen` der Wille des Kunden. Ein Aufruf ohne Fläche bleibt
   * zeichengleich auf `cockpit`.
   */
  tenantCockpitLayout: (surface: CockpitLayoutFlaeche = 'cockpit') =>
    request<CockpitLayoutResponse>(`/api/v1/tenant/cockpit-layout?surface=${surface}`),
  saveTenantCockpitLayout: (
    layer: CockpitLayoutLayer,
    document: CockpitLayoutDocument,
    surface: CockpitLayoutFlaeche = 'cockpit',
  ) =>
    request<CockpitLayoutResponse>(
      `/api/v1/tenant/cockpit-layout?surface=${surface}&layer=${layer}`,
      { method: 'PUT', body: JSON.stringify(document) },
    ),
  resetTenantCockpitLayout: (
    layer: CockpitLayoutLayer,
    surface: CockpitLayoutFlaeche = 'cockpit',
  ) =>
    request<CockpitLayoutResponse>(
      `/api/v1/tenant/cockpit-layout?surface=${surface}&layer=${layer}`,
      { method: 'DELETE' },
    ),
  /** Seed this site's starter flow DRAFT (customer twin, idempotent). */
  autoStart: (siteId: string) =>
    request<{ created: boolean; reason?: string | null; message?: string | null }>(
      `/api/v1/sites/${siteId}/flows/auto-start`,
      { method: 'POST' },
    ),
  /** Die Energie eines Geräts je Eimer nach der Zählerregel (Unterverteilungen C2). */
  entityEnergy: (siteId: string, entityId: string, range: HistoryRange, at?: string) =>
    request<EntityEnergy>(
      `/api/v1/sites/${siteId}/entities/${entityId}/energy?range=${range}${at ? `&at=${at}` : ''}`,
    ),
  /**
   * Save the site's battery master data by hand and maintain its controlling
   * device link ("Ihr Wechselrichter steuert diesen Speicher"). Omit deviceId
   * to auto-link the site's single device; pass it to pick on a multi-device
   * site. Returns the site's assets after the save.
   */
  /**
   * Die Leistung der Solarmodule von Hand (ohne MaStR-Nummer, Anlage-Flow a1 Paket 2): setzt die PV-Summe
   * der Anlage wie das Register; ein später übernommener Erzeuger bucht seine eigenen kWp dazu.
   */
  savePv: (siteId: string, capacityKwp: number) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/pv`, {
      method: 'PUT',
      body: JSON.stringify({ capacityKwp }),
    }),
  saveBattery: (siteId: string, input: SaveBatteryInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/battery`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /**
   * „Batterie am Standort abmelden" (vp-komp-loeschen E1): remove the site's
   * battery as one coherent action - the nameplate the optimizer reads, the
   * battery entity's flow-claim orphan and the entity/measurement point go
   * together, so nothing keeps planning a phantom battery. Recorded telemetry
   * is KEPT; only the live visibility ends. Returns the remaining assets.
   */
  unregisterBattery: (siteId: string) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/battery`, { method: 'DELETE' }),
  mastrLookup: (siteId: string, einheitNummer: string) =>
    request<MastrPreview>(`/api/v1/sites/${siteId}/mastr-lookup`, {
      method: 'POST',
      body: JSON.stringify({ einheitNummer }),
    }),
  mastrApply: (siteId: string, input: MastrApplyInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/mastr-apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** S2: jede Einheit am selben Netzanschluss wie die getippte Nummer. Nichts gespeichert. */
  mastrLokationLookup: (siteId: string, einheitNummer: string) =>
    request<MastrLokationPreview>(`/api/v1/sites/${siteId}/mastr-lokation-lookup`, {
      method: 'POST',
      body: JSON.stringify({ einheitNummer }),
    }),
  /** S2: die bestätigte Auswahl einer Lokations-Suche übernehmen. */
  mastrLokationApply: (siteId: string, input: MastrLokationApplyInput) =>
    request<RegisterEinheit[]>(`/api/v1/sites/${siteId}/mastr-lokation-apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** S1: jede registrierte Einheit der Anlage (Sonnenrose, Einheit-Blatt). */
  registerEinheiten: (siteId: string) =>
    request<RegisterEinheit[]>(`/api/v1/sites/${siteId}/register-einheiten`),
  /** S5: Zuordnungen + freie Geräte für den "Gerät zuordnen"-Dialog. */
  einheitGeraet: (siteId: string) => request<EinheitGeraet>(`/api/v1/sites/${siteId}/einheit-geraet`),
  einheitGeraetZuordnen: (siteId: string, einheitId: string, geraetId: string, art: 'messpunkt' | 'erzeugungseinheit') =>
    request<EinheitGeraet>(`/api/v1/sites/${siteId}/register-einheiten/${einheitId}/geraet`, {
      method: 'POST',
      body: JSON.stringify({ geraetId, art }),
    }),
  einheitGeraetEntfernen: (siteId: string, einheitId: string, linkId: string) =>
    request<EinheitGeraet>(`/api/v1/sites/${siteId}/register-einheiten/${einheitId}/geraet/${linkId}`, {
      method: 'DELETE',
    }),
  /** S5 (§4.4): "fehlt eine Einheit?" - gemessene Spitze gegen die Summe der bestätigten Einheiten. */
  registerEinheitenHinweis: (siteId: string) =>
    request<RegisterEinheitHinweis>(`/api/v1/sites/${siteId}/register-einheiten-hinweis`),
  /** S5 (§6): der Plattform-Admin "Register-Abgleich", cross-tenant. */
  adminRegisterAbgleich: () => request<RegisterAbgleich>('/api/v1/admin/register-abgleich'),
  prices: (siteId: string) => request<PriceSeries>(`/api/v1/sites/${siteId}/prices`),
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  priceHistory: (siteId: string, range: HistoryRange, at: string) =>
    request<PriceHistory>(`/api/v1/sites/${siteId}/price-history?range=${range}&at=${at}`),
  forecastQuality: (siteId: string, days = 30) =>
    request<ForecastQuality>(`/api/v1/sites/${siteId}/forecast-quality?days=${days}`),

  /**
   * Das Blatt "Rückblick" (S3, Bericht Abschnitt 9): je Prognoseart die
   * letzten sieben Tage des aktiven Modells, "am Vortag erwartet" neben
   * "gemessen", dazu der Rückblick-Satz. Mandantenbezogen wie jede
   * `/sites/**`-Route - eine fremde Anlage ist 404.
   */
  rueckblick: (siteId: string) =>
    request<RueckblickResponse>(`/api/v1/sites/${siteId}/forecast-rueckblick`),


  /**
   * Der Prognose-Schalter DIESER Anlage: welches Modell je Prognoseart sie
   * plant, woher die Wahl kommt (eigene · Plattform-Vorgabe · Standardmodell)
   * und ihre Umstellungs-Historie. Mandantenbezogen wie jede `/sites/**`-Route
   * - eine fremde Anlage ist 404.
   */
  siteForecastModels: (siteId: string) =>
    request<ModellWahlZustand>(`/api/v1/sites/${siteId}/forecast-models`),

  /**
   * „Kandidat übernehmen" FÜR DIESE ANLAGE - ab dem nächsten Planungslauf plant
   * sie mit diesem Modell, alle anderen Anlagen bleiben unverändert. Der
   * Rückweg ist derselbe Aufruf in die Gegenrichtung; die Umstellung wird
   * append-only protokolliert (von->zu, wer, wann).
   */
  promoteSiteForecastModel: (siteId: string, kind: 'load' | 'pv', model: string) =>
    request<ModellWahlZustand>(`/api/v1/sites/${siteId}/forecast-models`, {
      method: 'POST',
      body: JSON.stringify({ kind, model }),
    }),
  /** Ersparnis-Simulation: async job - POST starts (defaults from the site's
   * master data, body fields override), GET polls every ~2 s. */
  startSimulation: (siteId: string, input: SimulationRequestInput) =>
    request<{ simulationId: string }>(`/api/v1/sites/${siteId}/simulation`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  simulationStatus: (siteId: string, simulationId: string) =>
    request<SimulationStatus>(`/api/v1/sites/${siteId}/simulation/${simulationId}`),

  // --- UEMS: Messkanäle + berechnete Messstelle („Gesamtwert") ---

  /** Die Messkanäle einer Komponente mit ihrer Vertrags-Größe (Read-Model AP-04). */
  komponenteMesskanaele: (siteId: string, entityId: string, stichtag?: string) =>
    request<MesskanalListe>(`/api/v1/sites/${siteId}/komponenten/${entityId}/messkanaele${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`),

  /** Alle Messstellen des Kundenbereichs (für die Auswahl der berechneten). */
  messstellen: () => request<{ messstellen: Messstelle[] }>(`/api/v1/messstellen`),

  /** Eine einzelne Messstelle. */
  messstelle: (id: string) => request<Messstelle>(`/api/v1/messstellen/${id}`),

  /** Der Vorschlag für das nächste Kennzeichen (MS-…), unaufdringlich gezeigt. */
  kennzeichenVorschlag: () =>
    request<{ kennzeichen: string }>(`/api/v1/messstellen/kennzeichen-vorschlag`),

  /** Die UEMS-Geräte einer Anlage (AP-04 IP-10) — der Weg von der Komponente zum Gerät. */
  uemsGeraete: (siteId: string) =>
    request<{ geraete: UemsGeraet[] }>(`/api/v1/sites/${siteId}/geraete`),
  /** Der jüngste Wert je Punkt `erzeuger.*`; ohne Wert `keine_daten`, nie 0. */
  anlagensteuerungWerte: (siteId: string, geraetId: string) =>
    request<AnlagensteuerungWerte>(`/api/v1/sites/${siteId}/anlagensteuerungen/${geraetId}/werte`),
  /** Die Kurven des Bilds für Verlauf › Messwerte (UEMS EZ-10), im Fenster der Historie. */
  anlagensteuerungVerlauf: (siteId: string, geraetId: string, range: HistoryRange, at?: string) => {
    const q = new URLSearchParams({ range });
    if (at) q.set('at', at);
    return request<AnlagensteuerungVerlauf>(`/api/v1/sites/${siteId}/anlagensteuerungen/${geraetId}/verlauf?${q.toString()}`);
  },
  /** Stammdaten Netz und Vermarktung; `null` = älteres Backend (404). */
  netzVermarktung: (siteId: string) =>
    request<NetzVermarktung>(`/api/v1/sites/${siteId}/netz-vermarktung`).catch((e: unknown) =>
      e instanceof ApiError && e.status === 404 ? null : Promise.reject(e),
    ),
  netzVermarktungAendern: (siteId: string, body: NetzVermarktungAendern) =>
    request<NetzVermarktung>(`/api/v1/sites/${siteId}/netz-vermarktung`, { method: 'PUT', body: JSON.stringify(body) }),
  /** Ersetzt die Angaben einer Erzeugungseinheit; Umbenennen ändert nur die Anzeige. */
  erzeugungseinheitAendern: (geraetId: string, teNr: number, body: ErzeugungseinheitAendern) =>
    request<Erzeugungseinheit>(`/api/v1/geraete/${geraetId}/anlagensteuerung/einheiten/${teNr}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),


  /** AP-05 IP-9/IP-10: Kartendaten dokumentieren; Steckplatz kommt aus der physischen Zuordnung. */
  wagoKarteEintragen: (siteId: string, entityId: string, body: {
    // Der Name der Schnittstelle ist `expectedRevision` (WagoMetadataService.KartenEintrag);
    // `expected_revision` kam nie an und lief in ein 400 (gefunden in AP-05 IP-11).
    expectedRevision: number;
    anwenderskalierung: boolean | null;
    register35: number | null;
  }) => request<WagoKartenangaben>(
    `/api/v1/sites/${siteId}/components/${entityId}/wago`,
    { method: 'PUT', body: JSON.stringify(body) },
  ),

  /** AP-05 IP-11: die WAGO-Kartenangaben einer Komponente; keine WAGO-Komponente = 404. */
  wagoKarte: (siteId: string, entityId: string) =>
    request<WagoKartenangaben>(`/api/v1/sites/${siteId}/components/${entityId}/wago`),

  /** AP-05 IP-11 (E6): „Karte getauscht“ — Gerätegrenze OHNE Gerätewechsel. */
  wagoKartenwechsel: (siteId: string, entityId: string, body: WagoKartenwechsel) =>
    request<WagoKartenangaben>(
      `/api/v1/sites/${siteId}/components/${entityId}/wago/kartenwechsel`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /**
   * B05: die Karten-Komponenten EINER WAGO-Steuerung und ihren Controller in einer Transaktion
   * anlegen — je Karte Steckplatz und gelesener Kartentyp (ungelesen `null`, nie geraten).
   */
  wagoKartenAnlegen: (siteId: string, body: {
    karten: { steckplatz: number; kartentyp: number | null; komponente: SaveComponentBody }[];
    /** Der Anschluss der Steuerung (GE-6): der Controller verweist darauf. */
    dataSourceId?: string | null;
  }) => request<WagoKartenAnlage>(`/api/v1/sites/${siteId}/wago/karten`, {
    method: 'POST', body: JSON.stringify(body),
  }),

  /**
   * AP-05 „WAGO-Soll speichern“: die Box liest Kopf und Kartenkennungen der Steuerung; die api
   * speichert nur daraus und nur in leere Stellen — eine Abweichung überschreibt nichts.
   */
  wagoSollLesen: (geraetId: string, body: { deviceId: string }) =>
    request<WagoSollLesung>(`/api/v1/geraete/${geraetId}/wago/soll-lesen`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  /** AP-05 IP-9/IP-10: abgelesene Controller-Angaben, keine Geräteerkennung. */
  wagoGeraetEintragen: (id: string, body: WagoGeraeteangaben) =>
    request<WagoGeraeteangaben>(`/api/v1/geraete/${id}/wago`, {
      method: 'PUT', body: JSON.stringify(body),
    }),

  komponentenEreignisse: (siteId: string, entityId: string) =>
    request<KomponentenEreignis[]>(`/api/v1/sites/${siteId}/components/${entityId}/events`),

  messstelleZaehlerwechsel: (id: string, body: Zaehlerwechsel) =>
    request<ZaehlerwechselVorgang>(`/api/v1/messstellen/${id}/quellen/wechsel`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  controllerwechselVorschau: (id: string, zeitpunkt: string) =>
    request<ControllerwechselVorschau>(`/api/v1/geraete/${id}/austausch/vorschau?zeitpunkt=${encodeURIComponent(zeitpunkt)}`),
  wechselzeitpunktBerichtigen: (id: string, body: { bisher: string; zeitpunkt: string; grund?: string }) =>
    request<{ vorgaenger: string; nachfolger: string; bisher: string; zeitpunkt: string; satz: string }>(
      `/api/v1/geraete/${id}/austausch/zeitpunkt`, { method: 'POST', body: JSON.stringify(body) }),
  geraetAustauschen: (id: string, body: Zaehlerwechsel) =>
    request<ZaehlerwechselVorgang>(`/api/v1/geraete/${id}/austausch`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  /**
   * Die Datenquellen EINER Anlage (AP-06 IP-3) — AP-13 IP-12 ist ihr erster Aufrufer im Portal.
   * Gelesen wird daraus allein die Zuständigkeit: welche Box liest die Quelle, seit wann.
   */
  datenquellen: (siteId: string) =>
    request<UemsDatenquellenListe>(`/api/v1/sites/${siteId}/data-sources`),

  /**
   * Die Gemeinsame Steuerung der Anlage (UEMS AP-15 IP-5). Die Box-Seite liest daraus nur den
   * Zustand: in einer eingerichteten Anlage führt die Sperre `steuerquelle` auf „Gemeinsame
   * Steuerung ändern“ (IP-26). Ohne Gemeinsame Steuerung `zustand: nicht_eingerichtet`.
   */
  gemeinsameSteuerung: (siteId: string) =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/sites/${siteId}/gemeinsame-steuerung`),
  /** Der Vorschlag für die sechs Fragen (Vertrag §6a) — schreibt nie. */
  gemeinsameSteuerungEinrichten: (siteId: string) =>
    request<UemsGemeinsameSteuerungEinrichten>(`/api/v1/sites/${siteId}/gemeinsame-steuerung/einrichten`),
  /** Einrichten und Ändern (Recht `funktion.steuern_einrichten`); 422 `erklaerung_unvollstaendig` nennt die Lücken. */
  gemeinsameSteuerungSetzen: (siteId: string, body: UemsGemeinsameSteuerungSetzen) =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/sites/${siteId}/gemeinsame-steuerung`,
      { method: 'PUT', body: JSON.stringify(body) }),
  /**
   * Frage 6 für einen ENTWURF (§5.2 Nr. 6, vor „Absenden“): derselbe Körper und dieselben 422-Lücken wie das PUT,
   * die Antwort wie `GET …/einrichten` und das PUT (`zustand` mit `fehlt`) — schreibt nichts.
   */
  gemeinsameSteuerungVorschau: (siteId: string, body: UemsGemeinsameSteuerungSetzen) =>
    request<{ einrichten: UemsGemeinsameSteuerungEinrichten; zustand: UemsGemeinsameSteuerungZustand }>(`/api/v1/sites/${siteId}/gemeinsame-steuerung/einrichten/vorschau`,
      { method: 'POST', body: JSON.stringify(body) }),
  /** Den sicheren Rückfallwert am Gerät hinterlegen (Vertrag §6a, `GeraeteRueckfallDienst`). */
  gemeinsameSteuerungRueckfall: (siteId: string, komponenteId: string,
    body: { richtung: UemsSteuerRichtung; rueckfall: 'faellt_auf_wert'; rueckfall_kw: number }) =>
    request<unknown>(`/api/v1/sites/${siteId}/gemeinsame-steuerung/komponenten/${komponenteId}/rueckfall`,
      { method: 'PUT', body: JSON.stringify(body) }),
  /** Anhalten · Fortsetzen (Recht `steuerung.starten_beenden`); Scharfschalten ist nie eine Kundenroute (I5). */
  /** Betreiber-Blatt (IP-24): nur die Plattform-Rolle; die Handgriffe unter `/admin` (I4). */
  gemeinsameSteuerungBlatt: (siteId: string) =>
    request<UemsBetreiberblatt>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung`),

  /** Steuerlogik Stufe 2: das Blatt der Plattform (Fassungen, Quittung, Mitlauf). */
  steuerlogikBlatt: (siteId: string) => request<SteuerlogikBlatt>(`/api/v1/admin/sites/${siteId}/steuerlogik`),
  /**
   * Eine Logik als Text annehmen; mit `logikId` eine neue Fassung, die die laufende ablöst. `scharf` lässt sie gleich
   * scharf gehen (eine scharfe Fassung löst nur eine scharfe ab) und bestätigt damit die Hinweise.
   */
  steuerlogikAnnehmen: (siteId: string, text: string, logikId?: string, scharf = false) =>
    request<SteuerlogikAngenommen>(
      logikId ? `/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/fassungen` : `/api/v1/admin/sites/${siteId}/steuerlogik`,
      { method: 'POST', body: JSON.stringify(scharf ? { text, scharf: true, bestaetigt: true } : { text }) },
    ),
  steuerlogikStilllegen: (siteId: string, logikId: string) =>
    request<{ stillgelegt: boolean }>(`/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/stilllegen`, { method: 'POST' }),
  /** Das Vergleichsprotokoll eines Tages der Anlage (ohne `tag` heute). */
  steuerlogikWechsel: (siteId: string, logikId: string, tag?: string) =>
    request<SteuerlogikProtokoll>(
      `/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/wechsel${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`,
    ),
  /** Stufe 3: was der Dialog „Scharf schalten“ zeigt. */
  steuerlogikVorschau: (siteId: string, logikId: string) =>
    request<SteuerlogikVorschau>(`/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/scharf`),
  /** Die Fassung scharf schalten - eine Bestätigung für alle Hinweise (E5 = C). */
  steuerlogikScharf: (siteId: string, logikId: string, fassung: number) =>
    request<SteuerlogikAngenommen>(`/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/scharf`, {
      method: 'POST',
      body: JSON.stringify({ fassung, bestaetigt: true }),
    }),
  /** Zurück zur vorigen Fassung, im selben Zustand; wirkt sofort. */
  steuerlogikZurueck: (siteId: string, logikId: string) =>
    request<SteuerlogikAngenommen>(`/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/zurueck`, { method: 'POST' }),
  /** Die Schritte an einer Logik an einem Tag der Anlage. */
  steuerlogikProtokoll: (siteId: string, logikId: string, tag?: string) =>
    request<{ logikId: string; tag: string; schritte: SteuerlogikSchritt[] }>(
      `/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/protokoll${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`,
    ),

  /** Stufe 3, Kunde: die scharfen Logiken der Anlage als Karten. */
  siteSteuerlogik: (siteId: string) => request<{ logiken: SteuerlogikKarte[] }>(`/api/v1/sites/${siteId}/steuerlogik`),
  /** Der Verlauf eines Tages der Anlage: Schaltungen und Schritte von Menschen. */
  siteSteuerlogikVerlauf: (siteId: string, logikId: string, tag?: string) =>
    request<SteuerlogikVerlauf>(
      `/api/v1/sites/${siteId}/steuerlogik/${logikId}/verlauf${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`,
    ),
  /** Stufe 4: die Logiken der Anlage im Reiter „Regeln“, mit den Rechten des Aufrufers. */
  logikListe: (siteId: string) => request<LogikListe>(`/api/v1/sites/${siteId}/steuerlogik/logiken`),
  /** Stufe 4: was eine Logik an der Anlage lesen und schalten kann (Auswahl im Aufbau). */
  logikQuellen: (siteId: string) => request<LogikQuellen>(`/api/v1/sites/${siteId}/steuerlogik/quellen`),
  /** Stufe 4: eine Logik mit Fassungen, Anfragen, Werten und Lauf. */
  logikAnsicht: (siteId: string, logikId: string) =>
    request<LogikAnsicht>(`/api/v1/sites/${siteId}/steuerlogik/${logikId}`),
  /** Stufe 4: der Text einer Fassung. */
  logikText: (siteId: string, logikId: string, fassung: number) =>
    request<{ logikId: string; fassung: number; zustand: LogikZustand; text: string; bericht: LogikBericht | null }>(
      `/api/v1/sites/${siteId}/steuerlogik/${logikId}/fassungen/${fassung}`,
    ),
  /** Stufe 4: einen Text prüfen, mit denselben Regeln wie Dienst und Box; nichts wird gespeichert. */
  logikPruefen: (siteId: string, text: string, signal?: AbortSignal) =>
    request<LogikGeprueft>(`/api/v1/sites/${siteId}/steuerlogik/pruefe`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal,
    }),
  /** Stufe 4: als Fassung speichern (ohne `logikId` eine neue Logik); `basis` ist die Fassung, von der es ausging. */
  logikSpeichern: (siteId: string, text: string, notiz: string | null, logikId?: string, basis?: number) =>
    request<LogikGespeichert>(
      logikId ? `/api/v1/sites/${siteId}/steuerlogik/${logikId}/fassungen` : `/api/v1/sites/${siteId}/steuerlogik`,
      { method: 'POST', body: JSON.stringify({ text, notiz, basis: basis ?? null }) },
    ),
  /** Stufe 4: eine Fassung mitlaufen lassen, zur Freigabe vorlegen oder auf sie zurückgehen. */
  logikFassungSchritt: (siteId: string, logikId: string, fassung: number, schritt: 'mitlaufen' | 'vorlegen' | 'zurueck') =>
    request<SteuerlogikAngenommen | { vorgelegt: boolean; fassung: number }>(
      `/api/v1/sites/${siteId}/steuerlogik/${logikId}/fassungen/${fassung}/${schritt}`,
      { method: 'POST' },
    ),
  /** Stufe 4: die aktive Fassung stilllegen. */
  logikStilllegen: (siteId: string, logikId: string) =>
    request<{ stillgelegt: boolean }>(`/api/v1/sites/${siteId}/steuerlogik/${logikId}/stilllegen`, { method: 'POST' }),
  /** Stufe 4: eine Änderung anfragen, zu einem Wert oder zur ganzen Logik. */
  logikAnfragen: (siteId: string, logikId: string, text: string, kennung?: string | null) =>
    request<{ id: string }>(`/api/v1/sites/${siteId}/steuerlogik/${logikId}/anfragen`, {
      method: 'POST',
      body: JSON.stringify({ text, kennung: kennung ?? null }),
    }),
  logikAnfrageErledigt: (siteId: string, logikId: string, anfrageId: string) =>
    request<{ erledigt: boolean }>(`/api/v1/sites/${siteId}/steuerlogik/${logikId}/anfragen/${anfrageId}/erledigt`, {
      method: 'POST',
    }),
  /** Stufe 4: das Protokoll einer Logik über einen Zeitraum (Tage der Anlage; ohne Angabe 90 Tage). */
  logikProtokoll: (siteId: string, logikId: string, von?: string, bis?: string) =>
    request<{ logikId: string; von: string; bis: string; schritte: SteuerlogikSchritt[] }>(
      `/api/v1/sites/${siteId}/steuerlogik/${logikId}/protokoll${von || bis ? `?${new URLSearchParams({ ...(von ? { von } : {}), ...(bis ? { bis } : {}) })}` : ''}`,
    ),
  /** Stufe 4, Plattform: was der Dialog „Scharf schalten“ für eine bestimmte (vorgelegte) Fassung zeigt. */
  steuerlogikVorschauFassung: (siteId: string, logikId: string, fassung: number) =>
    request<SteuerlogikVorschau>(`/api/v1/admin/sites/${siteId}/steuerlogik/${logikId}/scharf?fassung=${fassung}`),
  /** Stufe 5: die Bausteine für diese Anlage, mit den Rechten des Aufrufers. */
  bausteinListe: (siteId: string) => request<BausteinListe>(`/api/v1/sites/${siteId}/steuerlogik/bausteine`),
  /** Stufe 5: einen Baustein füllen, ohne zu speichern - Prüfung und „So verhält sie sich“. */
  bausteinVorschau: (siteId: string, bausteinId: string, fuellung: BausteinFuellung, signal?: AbortSignal) =>
    request<BausteinEingesetzt>(`/api/v1/sites/${siteId}/steuerlogik/bausteine/${encodeURIComponent(bausteinId)}/vorschau`, {
      method: 'POST',
      body: JSON.stringify({ fuellung }),
      signal,
    }),
  /** Stufe 5: einen Baustein einsetzen - es entsteht eine Logik (Fassung 1, läuft noch nicht). */
  bausteinEinsetzen: (siteId: string, bausteinId: string, fuellung: BausteinFuellung) =>
    request<LogikGespeichert>(`/api/v1/sites/${siteId}/steuerlogik/bausteine/${encodeURIComponent(bausteinId)}/logik`, {
      method: 'POST',
      body: JSON.stringify({ fuellung }),
    }),
  /** Stufe 5: eine Fassung einer Logik als Baustein speichern (Fachbetrieb für seine Kunden, VoltPilot für alle). */
  bausteinSpeichern: (siteId: string, logikId: string, fassung: number, name: string, satz: string) =>
    request<{ id: string; herkunft: 'voltpilot' | 'fachbetrieb'; name: string; satz: BausteinSatzTeil[]; luecken: BausteinLuecke[] }>(
      `/api/v1/sites/${siteId}/steuerlogik/bausteine`,
      { method: 'POST', body: JSON.stringify({ logikId, fassung, name, satz }) },
    ),
  /** Stufe 5: einen eigenen Baustein aus der Sammlung entfernen. */
  bausteinEntfernen: (siteId: string, bausteinId: string) =>
    request<{ entfernt: boolean }>(`/api/v1/sites/${siteId}/steuerlogik/bausteine/${encodeURIComponent(bausteinId)}`, {
      method: 'DELETE',
    }),
  /** Einen Wert stellen, in der Form des Dokuments (`"72 °C"`, `"on"`, `"06:00"`). */
  siteSteuerlogikWert: (siteId: string, logikId: string, kennung: string, wert: unknown) =>
    request<{ logikId: string; kennung: string; wert: unknown; stand: number; veroeffentlicht: boolean }>(
      `/api/v1/sites/${siteId}/steuerlogik/${logikId}/stellwerte/${encodeURIComponent(kennung)}`,
      { method: 'PUT', body: JSON.stringify({ wert }) },
    ),

  gemeinsameSteuerungBetreiber: (siteId: string, schritt: 'scharfschalten' | 'fortsetzen') =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung/${schritt}`, { method: 'POST' }),

  gemeinsameSteuerungBestaetigen: (siteId: string, boxId: string) =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung/mitglieder/${boxId}/bestaetigen`, { method: 'POST' }),

  /** AP-15 §5.5 (nur Plattform-Rolle, I4): die Geräte einer ausscheidenden Box sind vom Netz. */
  gemeinsameSteuerungVomNetz: (siteId: string, boxId: string) =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung/mitglieder/${boxId}/ausscheiden-bestaetigen`, { method: 'POST' }),

  gemeinsameSteuerungSprungprobe: (siteId: string, body: { box_id: string; art: UemsSprungprobe['art']; sprung_kw: number }) =>
    request<UemsSprungprobe>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung/sprungprobe`,
      { method: 'POST', body: JSON.stringify(body) }),

  gemeinsameSteuerungSteckerprobe: (siteId: string, body: {
    von: string; bis: string; box_id: string; bemerkung?: string;
  }) => request<UemsSteckerprobe>(`/api/v1/admin/sites/${siteId}/gemeinsame-steuerung/steckerprobe`,
    { method: 'POST', body: JSON.stringify(body) }),

  gemeinsameSteuerungSchritt: (siteId: string, schritt: 'anhalten' | 'fortsetzen') =>
    request<UemsGemeinsameSteuerungZustand>(`/api/v1/sites/${siteId}/gemeinsame-steuerung/${schritt}`, { method: 'POST' }),

  datenquelleAnlegen: (siteId: string, body: UemsDatenquelleAnlegen) =>
    request<UemsDatenquelle>(`/api/v1/sites/${siteId}/data-sources`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  datenquelleBearbeiten: (siteId: string, id: string, body: UemsDatenquelleBearbeiten) =>
    request<UemsDatenquelle>(`/api/v1/sites/${siteId}/data-sources/${id}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),

  datenquellePruefen: (siteId: string, id: string, body: {
    device_id: string; unit_id: number; register: number;
    register_kind?: string; data_type?: string; word_order?: string;
    /** `wago_kopf`: der Kopf eines WAGO-Registerbilds an der Basisadresse `register` (ohne `data_type`). */
    /** `erzeuger_kopf` (EZ-15): Kopf, Einheiten und Namen eines Erzeuger-Registerbilds; der Block steht in `antwort`. */
    op?: 'read' | 'wago_kopf' | 'erzeuger_kopf';
  }) => request<UemsDatenquellePruefergebnis>(
    `/api/v1/sites/${siteId}/data-sources/${id}/reachability-check`,
    { method: 'POST', body: JSON.stringify(body) },
  ),

  /** Eine 422-Ablehnung trägt {@link DatenquelleBudgetFehler} in `ApiError.body`. */
  datenquelleZuweisen: (siteId: string, id: string, body: {
    device_id: string; effective_from?: string; vergleich_bestaetigt?: boolean;
  }) => request<{ urteil: 'erlaubt'; text: string; hinweis: string | null;
    vergleichsquelle: boolean; datenquelle: UemsDatenquelle }>(
    `/api/v1/sites/${siteId}/data-sources/${id}/assignments`,
    { method: 'POST', body: JSON.stringify(body) },
  ),

  /** Die Datenquellen-Vorschlagsliste der Anlage (AP-06 IP-4) — liest nur. */
  datenquellenVorschlag: (siteId: string) =>
    request<UemsDatenquelleVorschlagsliste>(`/api/v1/sites/${siteId}/data-sources/vorschlag`),

  /**
   * Bestätigt Vorschläge genau so, wie die Liste sie zeigte (sonst 409 `vorschlag_geaendert`).
   * Ein leerer Auftrag ist 400 — der Assistent schickt ihn nie.
   */
  datenquellenVorschlagUebernehmen: (siteId: string, vorschlaege: UemsDatenquelleBestaetigt[]) =>
    request<UemsDatenquelleUebernommen>(`/api/v1/sites/${siteId}/data-sources/vorschlag/uebernehmen`, {
      method: 'POST', body: JSON.stringify({ vorschlaege }),
    }),

  datenquelleZuweisungZuruecknehmen: (siteId: string, id: string, assignmentId: string) =>
    request<UemsDatenquelle>(
      `/api/v1/sites/${siteId}/data-sources/${id}/assignments/${assignmentId}`,
      { method: 'DELETE' },
    ),

  /** Die Einstellungs-Fassungen eines Einbaus (AP-04 IP-11) — gültig jetzt und die Historie. */
  geraetEinstellungen: (id: string) =>
    request<GeraetEinstellungen>(`/api/v1/geraete/${id}/einstellungen`),

  /** Trägt eine neue Fassung ein — sie legt sich zwischen die bestehenden, nie überschreibend. */
  geraetEinstellungEintragen: (id: string, body: EinstellungNeu) =>
    request<EinstellungEingetragen>(`/api/v1/geraete/${id}/einstellungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Das Änderungsprotokoll EINER Messstelle (AP-04 IP-21) — jüngster Eintrag
   * zuerst. Ohne `von`/`bis` das ganze Protokoll.
   */
  messstelleAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/messstellen/${id}/aenderungen${protokollFrage(f)}`),

  /**
   * Das Änderungsprotokoll EINES Geräts — seine Bindungen, seine Einstellungen,
   * sein Ein- und Ausbau. `id` ist das UEMS-Gerät (`/api/v1/sites/{id}/geraete`),
   * nicht die Komponente.
   */
  geraetAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/geraete/${id}/aenderungen${protokollFrage(f)}`),

  /** Das Änderungsprotokoll des ganzen Unternehmens über einen Zeitraum. */
  unternehmenAenderungen: (f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/unternehmen/aenderungen${protokollFrage(f)}`),

  /** Das Änderungsprotokoll EINES Gebäudes oder Bereichs (AP-02 IP-14, H2). */
  ortAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/orte/${id}/aenderungen${protokollFrage(f)}`),

  /**
   * Das Änderungsprotokoll EINES Standorts samt seinen Gebäuden, Bereichen und
   * Anlagen-Zuordnungen (AP-02 IP-14) — jedes Kind aus seiner Zeit an diesem Standort.
   */
  standortAenderungen: (id: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/standorte/${id}/aenderungen${protokollFrage(f)}`),

  /** Legt eine berechnete Messstelle (Gesamtwert) mit ihrer gewichteten Summe an. */
  berechneteMessstelleAnlegen: (body: BerechneteMessstelleAnlegen) =>
    request<Messstelle>(`/api/v1/messstellen/berechnet`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Die Formel (Terme + abgeleitete Hauptgröße) einer berechneten Messstelle —
   * ohne `am` die von heute (unverändert), mit `am` (JJJJ-MM-TT) die Fassung des Tages.
   */
  messstelleFormel: (id: string, am?: string) =>
    request<MessstelleFormel>(`/api/v1/messstellen/${id}/formel${am ? `?am=${am}` : ''}`),

  /** Trägt eine neue Fassung der Formel ab einem Tag ein (AP-10 IP-3). */
  messstelleFormelFassungEintragen: (id: string, body: MessstelleFormelFassungEintragen) =>
    request<MessstelleFormel>(`/api/v1/messstellen/${id}/formel/fassungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Der Live-Wert einer berechneten Messstelle (null, wenn unvollständig). */
  messstelleWert: (id: string) => request<MessstelleWert>(`/api/v1/messstellen/${id}/wert`),

  /**
   * Der maßgebliche Rollen-Wert EINES Geräts (Konzept vp-agg „verwenden als",
   * PR 758); `zugeordnet == null` = keine Zuordnung.
   */
  geraetSummenwerte: (siteId: string, entityId: string) =>
    request<GeraetSummenwert[]>(`/api/v1/sites/${siteId}/komponenten/${entityId}/summenwerte`),
  anlageRolleZuordnen: (siteId: string, role: SummenwertRolle, id: string, ersetzen = false) =>
    request<{ geraete: GeraetRolle[] }>(`/api/v1/sites/${siteId}/rollen/${role}`, {
      method: 'PUT', body: JSON.stringify({ art: 'gesamtwert', quell_messstelle_id: id, ersetzen }),
    }),
  rolleEntziehen: (siteId: string, entityId: string, role: SummenwertRolle) =>
    request<RollenZuordnungAntwort>(`/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`, { method: 'DELETE' }),
  anlageAenderungen: (siteId: string, f?: ProtokollAbfrage) =>
    request<Protokoll>(`/api/v1/sites/${siteId}/aenderungen${protokollFrage(f)}`),

  geraetRolle: (siteId: string, entityId: string, role: string) =>
    request<GeraetRolle>(`/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`),

  /**
   * Setzt den maßgeblichen Rollen-Wert eines Geräts (nativer Kanal ODER Gesamtwert);
   * die Antwort nennt den abgelösten Wert (is_primary-Semantik, Ersetzen statt doppelt
   * zählen).
   */
  rolleZuordnen: (siteId: string, entityId: string, role: string, body: RollenEingabe) =>
    request<RollenZuordnungAntwort>(
      `/api/v1/sites/${siteId}/komponenten/${entityId}/rollen/${role}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  /** Der Verlauf einer berechneten Messstelle (je 15 min die Summe, sonst null). */
  messstelleVerlauf: (id: string, range?: string) =>
    request<MessstelleVerlauf>(
      `/api/v1/messstellen/${id}/verlauf${range ? `?range=${range}` : ''}`,
    ),

  /**
   * Die Werte je Messstelle (UEMS AP-08 IP-9) über ihr HEUTIGES Kennzeichen: `von`/`bis` als Tag
   * (JJJJ-MM-TT, `bis` = letzter Tag einschließlich) in der Zeitzone des Standorts. Mit `version` (AP-08 IP-18)
   * genau diese Version der gespeicherten Zeile, ohne sie die neueste.
   */
  messstelleWerte: (kennzeichen: string, raster: MessstelleWerteRaster, von: string, bis: string, version?: number | null) =>
    request<MessstelleWerte>(
      `/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/werte?raster=${raster}&von=${von}&bis=${bis}` +
        (version == null ? '' : `&version=${version}`),
    ),

  /**
   * Die Versions-Historie EINER Periode (UEMS AP-08 IP-18): `von`/`bis` sind die des Schritts, wie die Route
   * `…/werte` sie liefert (Zeitpunkte mit Versatz, `bis` ausschließlich) — kodiert, sonst würde das `+` des
   * Versatzes zum Leerzeichen.
   */
  messstelleWerteVersionen: (
    kennzeichen: string,
    raster: MessstelleWerteHistorie['raster'],
    von: string,
    bis: string,
  ) =>
    request<MessstelleWerteHistorie>(
      `/api/v1/messstellen/${encodeURIComponent(kennzeichen)}/werte/versionen?raster=${raster}` +
        `&von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`,
    ),

  /**
   * Bearbeitet die drei änderbaren Felder einer Messstelle (Kennzeichen · Name ·
   * Notiz) — der Server ersetzt sie GANZ, ein fehlendes Feld wird leer. Zum
   * Umbenennen also das bestehende Kennzeichen mitschicken — und seit AP-08 IP-7 die
   * Anschlussleistung, sonst wird auch sie leer.
   */
  messstelleBearbeiten: (
    id: string,
    body: { kennzeichen?: string; name: string; notiz?: string; anschlussleistung_kw?: number | null },
  ) =>
    request<Messstelle>(`/api/v1/messstellen/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** Hält eine Messstelle an (behält ihre Definition). */
  messstelleAnhalten: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/anhalten`, { method: 'POST' }),

  /** Setzt eine angehaltene Messstelle fort. */
  messstelleFortsetzen: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/fortsetzen`, { method: 'POST' }),

  /** Archiviert eine Messstelle (statt hartem Löschen; das Kennzeichen bleibt belegt). */
  messstelleArchivieren: (id: string) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/archivieren`, { method: 'POST' }),

  // ---- Messstellen-Dialog (UEMS AP-04 IP-6): jeder Schritt schreibt über seine Route
  /** Legt eine gemessene Messstelle an; eine Ablehnung trägt Code und Fakten in `ApiError.body`. */
  messstelleAnlegen: (body: MessstelleAnlegen) =>
    request<Messstelle>(`/api/v1/messstellen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Der Ort ab einem Tag (IP-7) — Antwort: die Messstelle mit ihren Orten. */
  messstelleOrtAendern: (id: string, body: MessstelleOrtAendern) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/ort`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die elektrische Stellung ab einem Tag (IP-7) — 409 `hauptzaehler_vorhanden` nennt `bestehend`. */
  messstelleStellungAendern: (id: string, body: MessstelleStellungAendern) =>
    request<Messstelle>(`/api/v1/messstellen/${id}/stellung`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Bindet eine führende Quelle oder eine Vergleichsquelle (IP-13) — nie überschreibend. */
  messstelleQuelleBinden: (id: string, body: MessstelleQuelleBinden) =>
    request<MessstelleQuelleVorgang>(`/api/v1/messstellen/${id}/quellen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** UEMS AP-04 IP-14: je Größe die Quellen zum Stichtag (mit ihrem letzten Wert) und die Historie. */
  messstelleQuellen: (id: string, stichtag?: string | null) =>
    request<MessstelleQuellenListe>(
      `/api/v1/messstellen/${id}/quellen` + (stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''),
    ),
  /** Beendet eine Quelle (IP-13) — eine Quelle wird nie gelöscht, sie endet. */
  messstelleQuelleBeenden: (id: string, quelleId: string, body: MessstelleQuelleBeenden = {}) =>
    request<MessstelleQuelleVorgang>(`/api/v1/messstellen/${id}/quellen/${quelleId}/beenden`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** AP-01 IP-10b: Startprüfung aus frischen Fakten; fremde Anlage = 404. */
  funktionSteuernPruefung: (siteId: string) =>
    request<FunktionSteuernPruefung>(`/api/v1/sites/${encodeURIComponent(siteId)}/funktionen/steuern/pruefung`),
  /** AP-01 IP-3/IP-10b: Anlage aufnehmen bzw. Steuerung starten. */
  funktionSteuern: (siteId: string, aktion: FunktionSteuernAnfrage['aktion']) =>
    request<FunktionSteuernErgebnis>(`/api/v1/sites/${encodeURIComponent(siteId)}/funktionen/steuern`, {
      method: 'PUT', body: JSON.stringify({ aktion }),
    }),
  /** AP-01 IP-3/IP-11: alle teilnehmenden Anlagen eines Standorts anhalten bzw. fortsetzen. */
  funktionSteuernStandort: (standortId: string, aktion: 'anhalten' | 'fortsetzen') =>
    request<FunktionSteuernErgebnis>(`/api/v1/standorte/${encodeURIComponent(standortId)}/funktionen/steuern`, {
      method: 'PUT', body: JSON.stringify({ aktion }),
    }),
  /** UEMS AP-01 IP-9a: „Messen & Auswerten“ für einen Standort einrichten (Entwurf); ein zweites Mal ist 409 `bereits_angelegt`. */
  funktionMessenEinrichten: (standortId: string) =>
    request<FunktionMessenErgebnis>(`/api/v1/standorte/${encodeURIComponent(standortId)}/funktionen/messen`, {
      method: 'PUT',
      body: JSON.stringify({ aktion: 'einrichten' }),
    }),
  /** UEMS AP-04 IP-16 (Fläche AP-01 IP-9b): die Vorschlagsliste je Standort — liest nur, nichts entsteht ungefragt. */
  messstellenVorschlag: (standortId: string) =>
    request<MessstelleVorschlagsliste>(`/api/v1/standorte/${encodeURIComponent(standortId)}/messstellen-vorschlag`),
  /** Übernimmt die gewählten Zeilen, wie die Liste sie zeigte (nur `name` darf anders sein) — in EINER Transaktion. */
  messstellenVorschlagUebernehmen: (standortId: string, body: MessstelleVorschlagUebernehmen) =>
    request<MessstelleVorschlagUebernommen<Messstelle>>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/messstellen-vorschlag/uebernehmen`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** AP-10 IP-17/F15: welches System welches Gebäude am Tag versorgt. */
  versorgung: (standortId: string, stichtag?: string) =>
    request<Versorgung>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/versorgung${
        stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''
      }`,
    ),
  /** AP-02 IP-10: liest nur; vor der Bestätigung entsteht nichts. */
  standortZuordnungVorschlag: () =>
    request<StandortZuordnungVorschau>('/api/v1/standorte/vorschlag'),
  /** Legt alle gezeigten Gruppen und Zuordnungen in einer Transaktion an. */
  standortZuordnungBestaetigen: (body: StandortZuordnungBestaetigen) =>
    request<StandortZuordnungErgebnis>('/api/v1/standorte/vorschlag/bestaetigen', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  netzanschluesse: (standortId: string, stichtag?: string) =>
    request<Netzanschluesse>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse${stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''}`),
  netzanschlussGrenznachweis: (standortId: string, id: string, monat: string) =>
    request<NetzanschlussGrenzNachweis>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/${encodeURIComponent(id)}/grenznachweis?monat=${encodeURIComponent(monat)}`),
  netzanschlussVorschlaege: (standortId: string) =>
    request<NetzanschlussVorschlag[]>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege`),
  netzanschlussUebernehmen: (standortId: string, anlageId: string, body: NetzanschlussUebernehmen) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege/${encodeURIComponent(anlageId)}/uebernehmen`, { method: 'POST', body: JSON.stringify(body) }),
  netzanschlussVerwerfen: (standortId: string, anlageId: string) =>
    request<void>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/vorschlaege/${encodeURIComponent(anlageId)}/verwerfen`, { method: 'POST' }),
  netzanschlussAnlegen: (standortId: string, body: NetzanschlussAnfrage) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse`, { method: 'POST', body: JSON.stringify(body) }),
  netzanschlussBinden: (standortId: string, id: string, body: NetzanschlussBinden) =>
    request<Netzanschluss>(`/api/v1/standorte/${encodeURIComponent(standortId)}/netzanschluesse/${encodeURIComponent(id)}/anlagen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Das Kurzzeichen, das ein neuer Standort bekäme — bewegt den Zähler nicht. */
  standortKurzzeichenVorschlag: () =>
    request<StandortKurzzeichenVorschlag>('/api/v1/standorte/kurzzeichen-vorschlag'),

  /** Legt einen Standort an; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  standortAnlegen: (body: StandortStammdaten, anfrageKennung?: string) =>
    request<StandortAmStichtag>('/api/v1/standorte', {
      method: 'POST',
      body: JSON.stringify(body),
      ...mitKennung(anfrageKennung),
    }),

  /**
   * Adressvorschläge beim Anlegen (`GET /api/v1/orte/suche`, Anlage-Flow a1 D4): Straße und
   * Hausnummer genügen, nur Deutschland, Österreich und die Schweiz; 503, wenn die Datenquelle fehlt.
   */
  orteSuche: (q: string, signal?: AbortSignal) =>
    request<OrteSuchAntwort>(`/api/v1/orte/suche?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),

  /**
   * Die Adresse zu einem Kartenpunkt (`GET /api/v1/orte/rueckwaerts`, Task vp-anlage-adresse-ux):
   * ein Klick oder ein gezogener Pin löst sich damit in eine lesbare Adresse auf, wenn erreichbar.
   */
  orteRueckwaerts: (breitengrad: number, laengengrad: number, signal?: AbortSignal) =>
    request<OrteSuchAntwort>(`/api/v1/orte/rueckwaerts?lat=${breitengrad}&lon=${laengengrad}`, signal ? { signal } : {}),

  /** Schreibt die Stammdaten eines Standorts — die GANZE Menge, ein fehlendes Feld ist leer. */
  standortBearbeiten: (id: string, body: StandortStammdaten) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** Schreibt eine neue zeitgültige Bezugsflächen-Fassung des Standorts. */
  standortFlaeche: (id: string, body: OrtFlaeche) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}/flaeche`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ---- Ortsstruktur: Gebäude und Bereiche (UEMS AP-02 IP-5; Fläche dazu IP-7)
  /** Der Ortsbaum eines Standorts zum Stichtag (ohne: heute) — Gebäude mit Bereichen und „direkt am Standort“. */
  standortOrte: (standortId: string, stichtag?: string) =>
    request<OrtsbaumAmStichtag>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/orte${
        stichtag ? `?stichtag=${encodeURIComponent(stichtag)}` : ''
      }`,
    ),

  /** Das nächste freie G-/B-Kurzzeichen; bewegt den Zähler nicht. */
  ortKurzzeichenVorschlag: (standortId: string, art: 'gebaeude' | 'bereich') =>
    request<OrtKurzzeichenVorschlag>(
      `/api/v1/standorte/${encodeURIComponent(standortId)}/orte/kurzzeichen-vorschlag?art=${encodeURIComponent(art)}`,
    ),

  /** Legt ein Gebäude oder einen Bereich an; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  ortAnlegen: (standortId: string, body: OrtAnlegen) =>
    request<Ort>(`/api/v1/standorte/${encodeURIComponent(standortId)}/orte`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Schreibt die einfachen Felder eines Gebäudes oder Bereichs — die GANZE Menge. */
  ortBearbeiten: (ortId: string, body: OrtBearbeiten) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die Bezugsfläche eines Gebäudes oder Bereichs ab einem Tag (E3). */
  ortFlaeche: (ortId: string, body: OrtFlaeche) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/flaeche`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // ---- Archivieren · Wiederherstellen · Löschen (UEMS AP-02 IP-15); eine Ablehnung trägt OrtFehler.
  ortArchivieren: (ortId: string) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/archivieren`, { method: 'POST' }),
  /** `name`: das Umbenennen im selben Dialog, wenn der alte Name inzwischen vergeben ist. */
  ortWiederherstellen: (ortId: string, name?: string) =>
    request<Ort>(`/api/v1/orte/${encodeURIComponent(ortId)}/wiederherstellen`, {
      method: 'POST',
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    }),
  /** Nur ohne Historie (E1) — sonst 409 `loeschen_gesperrt`. */
  ortLoeschen: (ortId: string) => request<void>(`/api/v1/orte/${encodeURIComponent(ortId)}`, { method: 'DELETE' }),
  /** IP-12: was das Verschieben bewirken würde — schreibt nichts; eine Ablehnung trägt OrtFehler (mit `feld`). */
  ortVerschiebenVorschau: (ortId: string, zielId: string, gueltigAb: string) =>
    request<OrtVerschiebung>(
      `/api/v1/orte/${encodeURIComponent(ortId)}/verschieben/vorschau?zielId=${encodeURIComponent(
        zielId,
      )}&gueltigAb=${encodeURIComponent(gueltigAb)}`,
    ),
  /** IP-12: verschiebt ab `gueltigAb`; die Antwort nennt die Zuordnungen danach und den Protokolleintrag. */
  ortVerschieben: (ortId: string, body: OrtVerschiebenAnfrage) =>
    request<OrtVerschiebung>(`/api/v1/orte/${encodeURIComponent(ortId)}/verschieben`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  standortArchivieren: (id: string) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}/archivieren`, { method: 'POST' }),
  standortWiederherstellen: (id: string, name?: string) =>
    request<StandortAmStichtag>(`/api/v1/standorte/${encodeURIComponent(id)}/wiederherstellen`, {
      method: 'POST',
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    }),

  /** Die Folgen, bevor eine Anlage einem Standort zugeordnet wird (UEMS AP-02 IP-11) — schreibt nichts. */
  anlageStandortVorschau: (siteId: string, standortId: string, gueltigAb: string) =>
    request<AnlageUmzug>(
      `/api/v1/sites/${encodeURIComponent(siteId)}/standort/vorschau?standortId=${encodeURIComponent(
        standortId,
      )}&gueltigAb=${encodeURIComponent(gueltigAb)}`,
    ),

  /** Ordnet die Anlage ab `gueltigAb` einem Standort zu; eine Ablehnung trägt {@link OrtFehler} in `ApiError.body`. */
  anlageStandortSetzen: (siteId: string, body: AnlageUmzugAnfrage) =>
    request<AnlageUmzug>(`/api/v1/sites/${encodeURIComponent(siteId)}/standort`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  kostenstelleAnlegen: (body: KostenstelleProzessAnlegen) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen`, { method: 'POST', body: JSON.stringify(body) }),

  kostenstelleUmbenennen: (id: string, name: string) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),

  /** Beendet (der letzte Tag) — beenden statt löschen; 409 `zuordnung_besteht` nennt, was länger gilt. */
  kostenstelleBeenden: (id: string, gueltig_bis: string) =>
    request<Kostenstelle>(`/api/v1/unternehmen/kostenstellen/${id}/beenden`, {
      method: 'PUT',
      body: JSON.stringify({ gueltig_bis }),
    }),

  /**
   * Die Kostenstellen-Sicht EINER Kostenstelle (AP-10 IP-11): gemessen · verteilt · berechnet · Summe · nicht verteilt
   * und die Warnung vor doppelter Zählung. Gemerkt je Kostenstelle und Zeitraum ({@link GEMERKT_MS}, AP-13 IP-9).
   */
  kostenstelleEnergie: (id: string, periode: KostenstelleEnergiePeriode, am: string, version?: number | null) =>
    gemerkteAnfrage<KostenstelleEnergie>(
      `/api/v1/unternehmen/kostenstellen/${encodeURIComponent(id)}/energie?periode=${periode}&am=${am}` +
        (version == null ? '' : `&version=${version}`),
    ),

  prozessAnlegen: (body: KostenstelleProzessAnlegen) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse`, { method: 'POST', body: JSON.stringify(body) }),

  prozessUmbenennen: (id: string, name: string) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),

  prozessBeenden: (id: string, gueltig_bis: string) =>
    request<Prozess>(`/api/v1/unternehmen/prozesse/${id}/beenden`, {
      method: 'PUT',
      body: JSON.stringify({ gueltig_bis }),
    }),

  /** Die Prozesse einer Messstelle: alle wirksamen Intervalle, mit `am` die an dem Tag geltenden. */
  messstelleProzesse: (id: string, am?: string) =>
    request<MessstelleProzesse>(`/api/v1/messstellen/${id}/prozesse${am ? `?am=${encodeURIComponent(am)}` : ''}`),
  /** AP-16 IP-14: gemessene und berechnete Messstellen des Prozesses samt P4-Hinweisen. */
  prozessMessstellen: (id: string, am: string) =>
    request<ProzessMessstellen>(`/api/v1/unternehmen/prozesse/${id}/messstellen?am=${encodeURIComponent(am)}`),

  /** Ab `gueltig_ab` gehört die Messstelle zu GENAU diesen Prozessen (leer = zu keinem). */
  messstelleProzesseSetzen: (id: string, body: { gueltig_ab: string; prozesse: string[]; grund?: string | null }) =>
    request<MessstelleProzesse>(`/api/v1/messstellen/${id}/prozesse`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Die Verteilung einer Messstelle auf Kostenstellen (AP-10 IP-8): alle Anteile, mit `am` die des Tages. */
  messstelleVerteilung: (id: string, am?: string) =>
    request<MessstelleVerteilung>(`/api/v1/messstellen/${id}/verteilung${am ? `?am=${encodeURIComponent(am)}` : ''}`),

  /** Ab `gueltig_ab` gilt GENAU dieser Satz (alle Ziele des Tages; leer = nicht verteilt); `korrektur` ersetzt den vom selben Tag. */
  messstelleVerteilungSetzen: (
    id: string,
    body: { gueltig_ab: string; zeilen: VerteilungZeileEingabe[]; korrektur?: boolean | null; grund?: string | null },
  ) => request<MessstelleVerteilung>(`/api/v1/messstellen/${id}/verteilung`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Bestätigt „Rest anlegen“ (E18) — nie zweimal: ein zweiter Klick liefert `neu` = false. */
  anlageRestAnlegen: (siteId: string, body: { hauptzaehler_id: string; name?: string }) =>
    request<BilanzRestAngelegt>(`/api/v1/sites/${siteId}/bilanz/rest`, { method: 'POST', body: JSON.stringify(body) }),

  /** Die Bezugsgrößen des Kundenbereichs, archivierte eingeschlossen (AP-09 IP-5) — daneben die Bezugsflächen der Ortsstruktur (IP-6). */
  bezugsgroessen: () =>
    request<BezugsgroessenListe>(`/api/v1/bezugsgroessen`),

  /** Die Bezugsflächen mit ihrem Wert je Periode am Stichtag (E17, S3) — nur lesen, es gibt keinen Schreibweg. */
  bezugsflaechen: (periodeArt: 'tag' | 'woche' | 'monat' | 'jahr', von: string, bis: string) =>
    request<Bezugsflaechen>(
      `/api/v1/bezugsflaechen?periode_art=${periodeArt}&von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`,
    ),

  /** Die Intervalle eines Stammdatums (E15); mit Periode zusätzlich der Wert je Periode am Stichtag. */
  bezugsgroesseStammdatum: (id: string, periode?: { periodeArt: 'tag' | 'woche' | 'monat' | 'jahr'; von: string; bis: string }) =>
    request<BezugsgroesseStammdatum>(
      `/api/v1/bezugsgroessen/${id}/stammdatum` +
        (periode
          ? `?periode_art=${periode.periodeArt}&von=${encodeURIComponent(periode.von)}&bis=${encodeURIComponent(periode.bis)}`
          : ''),
    ),

  /** Ein Wert eines Stammdatums ab einem Tag (E15/S4); eine Ablehnung trägt `code` aus `bezugsgroesse.ts`. */
  bezugsgroesseStammdatumEintragen: (id: string, body: { wert: string; gueltig_ab: string }) =>
    request<BezugsgroesseStammdatum>(`/api/v1/bezugsgroessen/${id}/stammdatum`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  bezugsgroesse: (id: string) => request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}`),

  /** Legt eine Bezugsgröße an; eine Ablehnung trägt `code` aus `bezugsgroesse.ts` (`ABLEHNUNGEN`). */
  bezugsgroesseAnlegen: (body: BezugsgroesseAnfrage) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen`, { method: 'POST', body: JSON.stringify(body) }),

  /** Ändert die GANZE Bezugsgröße (mit Kennzeichen); nach dem ersten Wert nur Name und Kennzeichen. */
  bezugsgroesseAendern: (id: string, body: BezugsgroesseAnfrage & { kennzeichen: string }) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  /** Archiviert eine Bezugsgröße — die Werte bleiben lesbar, das Kennzeichen belegt. */
  bezugsgroesseArchivieren: (id: string) =>
    request<Bezugsgroesse>(`/api/v1/bezugsgroessen/${id}/archivieren`, { method: 'POST' }),

  /** Löscht eine Bezugsgröße ohne einen einzigen Wert (sonst 409 `hat_werte`). */
  bezugsgroesseLoeschen: (id: string) =>
    request<void>(`/api/v1/bezugsgroessen/${id}`, { method: 'DELETE' }),

  /** Vorschau und Übernahme schicken die Datei erneut; der Browser setzt die Multipart-Grenze. */
  bezugsdatenVorschau: (datei: File, zuordnung: BezugsdatenZuordnung | null, vorlageId: string | null = null) => {
    const body = new FormData(); body.append('datei', datei);
    if (vorlageId) body.append('vorlage_id', vorlageId); else body.append('zuordnung', JSON.stringify(zuordnung));
    return request<BezugsdatenVorschau>('/api/v1/bezugsdaten/importe/vorschau', { method: 'POST', body });
  },
  bezugsdatenImportieren: (datei: File, zuordnung: BezugsdatenZuordnung | null, vorlageId: string | null, bestaetigung: { vorschau: string; entscheidungen: Record<number, string>; begruendung: string | null; teiluebernahme: string | null }) => {
    const body = new FormData(); body.append('datei', datei);
    if (vorlageId) body.append('vorlage_id', vorlageId); else body.append('zuordnung', JSON.stringify(zuordnung));
    body.append('bestaetigung', JSON.stringify(bestaetigung));
    return request<BezugsdatenImportErgebnis>('/api/v1/bezugsdaten/importe', { method: 'POST', body });
  },
  bezugsdatenImporte: () => request<{ importe: BezugsdatenImportProtokollEintrag[] }>('/api/v1/bezugsdaten/importe'),
  bezugsdatenImport: (kennung: string) => request<BezugsdatenImportProtokollEintrag>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}`),
  bezugsdatenRuecknahmeVorschau: (kennung: string) => request<BezugsdatenRuecknahmeVorschau>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}/ruecknahme/vorschau`),
  bezugsdatenImportZuruecknehmen: (kennung: string, begruendung: string) => request<BezugsdatenImportErgebnis>(`/api/v1/bezugsdaten/importe/${encodeURIComponent(kennung)}/ruecknahme`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  bezugsdatenVorlagen: () => request<{ vorlagen: BezugsdatenVorlage[] }>('/api/v1/bezugsdaten/vorlagen'),
  bezugsdatenVorlageSpeichern: (body: { vorlage_id?: string; name: string; zuordnung: BezugsdatenZuordnung }) =>
    request<BezugsdatenVorlage>('/api/v1/bezugsdaten/vorlagen', { method: 'POST', body: JSON.stringify(body) }),
  /** Konzept Auswerten a1 (PR2): mit `mit = 'auswertung'` trägt die Kennzahl dieselbe Auswertung wie in der Liste. */
  kennzahl: (id: string, mit?: 'auswertung') =>
    request<Kennzahl>(`/api/v1/kennzahlen/${id}${mit ? `?mit=${mit}` : ''}`),
  /** Legt die Kennzahl mit Fassung 1 „gilt seit Beginn“ an. */
  kennzahlAnlegen: (body: KennzahlAnfrage) =>
    request<Kennzahl>(`/api/v1/kennzahlen`, { method: 'POST', body: JSON.stringify(body) }),
  /** Prüft und rechnet die letzten drei Perioden — schreibt nichts. */
  kennzahlVorschau: (body: KennzahlAnfrage) =>
    request<KennzahlVorschau>(`/api/v1/kennzahlen/vorschau`, { method: 'POST', body: JSON.stringify(body) }),
  /** Der Vorlagen-Katalog (AP-11 IP-10) — dieselben Knoten wie die Portal-Kopie `src/kennzahlen/kennzahl-vorlagen.json`. */
  kennzahlVorlagen: () => request<KennzahlVorlagen>(`/api/v1/kennzahl-vorlagen`),
  /** Die GANZEN Stammdaten ohne Fassung. */
  kennzahlAendern: (id: string, body: { kennzeichen: string; name: string; verantwortlich_name: string; zweck?: string | null }) =>
    request<Kennzahl>(`/api/v1/kennzahlen/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  kennzahlArchivieren: (id: string) => request<Kennzahl>(`/api/v1/kennzahlen/${id}/archivieren`, { method: 'POST' }),
  /** Nur ohne Wert und ohne lesende Kennzahl (sonst 409 `hat_werte` bzw. `wird_gelesen`). */
  kennzahlLoeschen: (id: string) => request<void>(`/api/v1/kennzahlen/${id}`, { method: 'DELETE' }),
  kennzahlFassungen: (id: string) =>
    request<{ kennzahl_id: string; kennzeichen: string; fassungen: KennzahlFassung[] }>(`/api/v1/kennzahlen/${id}/fassungen`),
  /** Die Berechnung ab einem Tag als Fassung n + 1, mit Begründung, auch rückwirkend. */
  kennzahlFassungEintragen: (
    id: string,
    body: { gueltig_ab: string; begruendung: string; periode_art?: KennzahlPeriodeArt | null; komplement?: boolean | null; eingaenge: KennzahlEingang[] },
  ) =>
    request<{ kennzahl_id: string; kennzeichen: string; fassungen: KennzahlFassung[] }>(`/api/v1/kennzahlen/${id}/fassungen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Die Fassung, die am Tag `am` (JJJJ-MM-TT, Vorgabe heute) galt. */
  kennzahlBerechnung: (id: string, am?: string) =>
    request<{ kennzahl_id: string; kennzeichen: string; am: string; fassung: KennzahlFassung }>(
      `/api/v1/kennzahlen/${id}/berechnung` + (am ? `?am=${encodeURIComponent(am)}` : ''),
    ),
  /**
   * Die Werte einer Kennzahl je Periode (AP-11 IP-7): `von` der erste, `bis` der LETZTE Tag einer Periode; ohne
   * `version` je Schritt die neueste. Ungerundet — gerundet wird nur in der Anzeige.
   */
  kennzahlWerte: (id: string, periode: KennzahlPeriodeArt, von: string, bis: string, version?: number) =>
    request<KennzahlWerte>(
      `/api/v1/kennzahlen/${id}/werte?periode=${periode}&von=${von}&bis=${bis}` + (version ? `&version=${version}` : ''),
    ),
  /** Die Versionen EINER Periode (`von` = ihr erster Tag) — wer, wann, warum, und was vorher dastand. */
  kennzahlWertVersionen: (id: string, periode: KennzahlPeriodeArt, von: string) =>
    request<KennzahlWerteHistorie>(`/api/v1/kennzahlen/${id}/werte/versionen?periode=${periode}&von=${von}`),
  /**
   * UEMS AP-17 IP-8 — die Bezugsbasen einer Kennzahl (je Eintrag die Form von `GET …/bezugsbasen/{bid}`, laufende
   * zuerst): die EINE Naht, über die Reiter, Basis-Zeile (IP-9) und der Vergleich (IP-20, Wahl erst ab zwei) ihre Basen finden.
   */
  kennzahlBezugsbasen: (id: string) => request<{ bezugsbasen: Bezugsbasis[] }>(`/api/v1/kennzahlen/${id}/bezugsbasen`),
  /** Legt BB-… an (IP-7, B1/B4) — noch ohne Fassung. */
  bezugsbasisAnlegen: (id: string) =>
    request<Bezugsbasis>(`/api/v1/kennzahlen/${id}/bezugsbasen`, { method: 'POST', body: JSON.stringify({}) }),
  /** Entwurf mit Vorschau (F1): der offene Entwurf wird neu gebildet; die Antwort ist die gespeicherte Fassung. */
  bezugsbasisEntwurf: (id: string, bid: string, body: BezugsbasisEntwurf) =>
    request<BezugsbasisFassung>(`/api/v1/kennzahlen/${id}/bezugsbasen/${bid}/fassungen`, { method: 'POST', body: JSON.stringify(body) }),
  bezugsbasisFassung: (id: string, bid: string, n: number) =>
    request<BezugsbasisFassung>(`/api/v1/kennzahlen/${id}/bezugsbasen/${bid}/fassungen/${n}`),
  /**
   * IP-8 (F1/F2): `beantragen` nur bei Vier-Augen (sonst 409 `vieraugen_aus`), `freigeben` gibt ohne Vier-Augen den
   * Entwurf frei bzw. bestätigt mit Vier-Augen den Antrag (Entwurf dann 409 `vieraugen_beantragen`), `ablehnen` einen
   * Antrag — je mit Begründung 10–500, Recht `bezugsbasis.freigeben`.
   */
  bezugsbasisFreigabe: (id: string, bid: string, n: number, schritt: 'beantragen' | 'freigeben' | 'ablehnen', begruendung: string) =>
    request<BezugsbasisFassung>(`/api/v1/kennzahlen/${id}/bezugsbasen/${bid}/fassungen/${n}/${schritt}`, {
      method: 'POST', body: JSON.stringify({ begruendung }),
    }),
  /** AP-17 IP-17 (F5, A4): „geprüft, bleibt“ mit Begründung 10–500 — die Fassung bleibt, die Frist beginnt neu. */
  bezugsbasisBleibt: (id: string, bid: string, begruendung: string) =>
    request<BezugsbasisZustand>(`/api/v1/kennzahlen/${id}/bezugsbasen/${bid}/bleibt`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  /** AP-17 IP-17 (F4): beenden — `tag` ist der letzte eingeschlossene Tag, vor heute nur mit `rueckwirkend`. */
  bezugsbasisBeenden: (id: string, bid: string, body: { tag: string; grund: string; begruendung: string; rueckwirkend?: boolean }) =>
    request<BezugsbasisZustand>(`/api/v1/kennzahlen/${id}/bezugsbasen/${bid}/beenden`, { method: 'POST', body: JSON.stringify(body) }),
  // ------------------------------------------------------------------ Energieziele (UEMS AP-18 IP-6/IP-7)
  /** IP-6 (Z1): das Register — wahlweise einer Kennzahl oder eines Zustands; Recht `verbesserung.ansehen`. */
  energieziele: (filter: { kennzahl?: string; zustand?: EnergiezielZustand } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => !!e[1])).toString();
    return request<EnergiezielListe>(`/api/v1/energieziele${q ? `?${q}` : ''}`);
  },
  /** IP-6 (Z1/Z2): anlegen an einer Kennzahl mit freigegebener Bezugsbasis; Recht `verbesserung.verwalten`. */
  energiezielAnlegen: (body: EnergiezielNeu) =>
    request<Energieziel>('/api/v1/energieziele', { method: 'POST', body: JSON.stringify(body) }),
  energieziel: (id: string) => request<Energieziel>(`/api/v1/energieziele/${id}`),
  /** IP-6 (Z3/Z4): der Ziel-Stand — je Monat der Vergleich, Σ ÷ Σ, „x von y“, Vorschlag nur bei vollständiger Periode. */
  energiezielStand: (id: string) => request<EnergiezielStand>(`/api/v1/energieziele/${id}/stand`),
  /** IP-6 (Z5): vorzeitig beenden (Tag, Begründung 10–500) — endgültig, nie gelöscht. */
  energiezielBeenden: (id: string, body: { zum?: string; begruendung: string }) =>
    request<Energieziel>(`/api/v1/energieziele/${id}/beenden`, { method: 'POST', body: JSON.stringify(body) }),
  /**
   * IP-7 (Z4/Z5, Muster Basis-Fassung AP-17 IP-8): `bewerten` setzt Ergebnis und Begründung (mit Vier-Augen 409
   * `vieraugen_beantragen`), `beantragen` stellt den Antrag (ohne Vier-Augen 409 `vieraugen_aus`), `freigeben` (Begründung
   * wahlfrei) und `ablehnen` entscheidet eine ZWEITE Person mit Rolle KA/EM; Recht `verbesserung.abschliessen`.
   */
  energiezielBewertung: (id: string, schritt: EnergiezielBewertungSchritt, body: { ergebnis?: EnergiezielErgebnis; begruendung?: string }) =>
    request<Energieziel>(`/api/v1/energieziele/${id}/${schritt === 'bewerten' ? 'bewerten' : `bewertung/${schritt}`}`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  /** IP-17-NAHT (Z5): Antwort auf einen Anstoß am Energieziel — `bleibt` (Begründung) oder `neu_bewertet`. */
  energiezielAnstossAntwort: (id: string, aid: string, body: VorgangAnstossAntwort) =>
    request<Energieziel>(`/api/v1/energieziele/${id}/anstoesse/${aid}/antwort`, { method: 'POST', body: JSON.stringify(body) }),
  // ------------------------------------------------------------------ Maßnahmen (UEMS AP-18 IP-10)
  /** Das Register im Zaun; `frist` beim Abruf (E5 = A). Gefiltert wird im Portal über die gelesene Liste. */
  massnahmen: () => request<MassnahmeListe>('/api/v1/massnahmen'),
  /**
   * Konzept Verbessern, Entscheid 5: die Maßnahmen für ein Energieziel und die, deren Wirkung schon im Stand enthalten
   * ist (an derselben Kennzahl umgesetzt) - diese zusätzlich in `im_stand_enthalten`.
   */
  massnahmenZumEnergieziel: (energiezielId: string) =>
    request<MassnahmeListe>(`/api/v1/massnahmen?energieziel=${encodeURIComponent(energiezielId)}`),
  massnahme: (id: string) => request<Massnahme>(`/api/v1/massnahmen/${id}`),
  /** Entscheid 13: die Umrechnung der erwarteten Wirkung in kWh im Jahr - liest nur, festgehalten wird beim Anlegen. */
  massnahmeSchaetzung: (kennzahl: string, prozent: number) =>
    request<MassnahmeSchaetzung>(
      `/api/v1/massnahmen/schaetzung?kennzahl=${encodeURIComponent(kennzahl)}&prozent=${encodeURIComponent(String(prozent))}`,
    ),
  massnahmeAnlegen: (body: MassnahmeNeu) =>
    request<Massnahme>('/api/v1/massnahmen', { method: 'POST', body: JSON.stringify(body) }),
  massnahmeAendern: (id: string, body: MassnahmeAendern) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  massnahmeVerantwortlicher: (id: string, body: { benutzer: string; begruendung: string }) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/verantwortlicher`, { method: 'PUT', body: JSON.stringify(body) }),
  massnahmeUmgesetzt: (id: string, body: { am: string; begruendung: string }) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/umgesetzt`, { method: 'POST', body: JSON.stringify(body) }),
  massnahmeVerwerfen: (id: string, body: { begruendung: string }) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/verwerfen`, { method: 'POST', body: JSON.stringify(body) }),
  massnahmeKommentar: (id: string, body: { text: string }) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/eintraege`, { method: 'POST', body: JSON.stringify(body) }),
  /** IP-11 (WK1–WK5): die Wirkung — ein Leser; `monate` 12 … 36 (Vorgabe 12), sonst 400. */
  massnahmeWirkung: (id: string, monate?: number) =>
    request<MassnahmeWirkung>(`/api/v1/massnahmen/${id}/wirkung${monate ? `?monate=${monate}` : ''}`),
  /** IP-12 (WK6): alle Stände der Bewertung nach Nr., auch beantragte und abgelehnte. */
  massnahmeBewertungen: (id: string) => request<MassnahmeBewertungen>(`/api/v1/massnahmen/${id}/bewertungen`),
  /**
   * IP-12 (WK6, Muster Energieziel IP-7): `bewerten` setzt Stand Nr. n (mit Vier-Augen 409 `vieraugen_beantragen`),
   * `beantragen` stellt den Antrag, `freigeben` (Begründung wahlfrei) und `ablehnen` entscheidet eine ZWEITE Person —
   * nie der Urheber, nie der Verantwortliche; Recht `verbesserung.abschliessen`.
   */
  massnahmeBewertung: (id: string, schritt: MassnahmeBewertungSchritt, body: { ergebnis?: MassnahmeErgebnis; begruendung?: string }) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/bewertungen${schritt === 'bewerten' ? '' : `/${schritt}`}`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  /** IP-17-NAHT (M5): Antwort auf einen Anstoß an der Maßnahme — `bleibt` (Begründung), `neu_kopiert`, `neu_bewertet`. */
  massnahmeAnstossAntwort: (id: string, aid: string, body: VorgangAnstossAntwort) =>
    request<Massnahme>(`/api/v1/massnahmen/${id}/anstoesse/${aid}/antwort`, { method: 'POST', body: JSON.stringify(body) }),
  // ------------------------------------------------------------------ Auffälligkeiten und Abweichungen (UEMS AP-18 IP-16)
  /** Die Vermerke einer Kennzahl — offen und beantwortet; `offen` zählt immer alle offenen. */
  auffaelligkeiten: (kennzahlId: string) => request<AuffaelligkeitListe>(`/api/v1/kennzahlen/${kennzahlId}/auffaelligkeiten`),
  /** Verbessern (Entscheid 4): die Vermerke aller sichtbaren Kennzahlen; beantwortet wird an der Kennzahl. */
  alleAuffaelligkeiten: (zustand?: Auffaelligkeit['zustand']) =>
    request<AuffaelligkeitenAlle>(`/api/v1/auffaelligkeiten${zustand ? `?zustand=${zustand}` : ''}`),
  auffaelligkeitAntworten: (kennzahlId: string, vermerkId: string, body: AuffaelligkeitAntwort) =>
    request<{ vermerk: Auffaelligkeit; abweichung: Abweichung | null }>(
      `/api/v1/kennzahlen/${kennzahlId}/auffaelligkeiten/${vermerkId}/antwort`, { method: 'POST', body: JSON.stringify(body) }),
  /** Das Register im Zaun; `frist` beim Abruf (E5 = A). Gefiltert wird im Portal über die gelesene Liste. */
  abweichungen: () => request<AbweichungListe>('/api/v1/abweichungen'),
  abweichung: (id: string) => request<Abweichung>(`/api/v1/abweichungen/${id}`),
  abweichungEroeffnen: (body: AbweichungNeu) =>
    request<Abweichung>('/api/v1/abweichungen', { method: 'POST', body: JSON.stringify(body) }),
  abweichungEintrag: (id: string, body: AbweichungEintragNeu) =>
    request<Abweichung>(`/api/v1/abweichungen/${id}/eintraege`, { method: 'POST', body: JSON.stringify(body) }),
  abweichungFrist: (id: string, body: { frist: string; begruendung: string }) =>
    request<Abweichung>(`/api/v1/abweichungen/${id}/frist`, { method: 'PUT', body: JSON.stringify(body) }),
  abweichungVerantwortlicher: (id: string, body: { benutzer: string; begruendung: string }) =>
    request<Abweichung>(`/api/v1/abweichungen/${id}/verantwortlicher`, { method: 'PUT', body: JSON.stringify(body) }),
  abweichungAbschliessen: (id: string, body: { ergebnis: AbweichungErgebnis; begruendung: string; massnahme?: string }) =>
    request<Abweichung>(`/api/v1/abweichungen/${id}/abschliessen`, { method: 'POST', body: JSON.stringify(body) }),
  kennzahlVariablenVorschlag: (id: string, referenzperiode?: string) =>
    request<VariablenVorschlag>(`/api/v1/kennzahlen/${id}/variablen-vorschlag` + (referenzperiode ? `?referenzperiode=${encodeURIComponent(referenzperiode)}` : '')),
  kennzahlFaktorenVorschlag: (id: string, stichtag?: string) =>
    request<FaktorenVorschlag>(`/api/v1/kennzahlen/${id}/faktoren-vorschlag` + (stichtag ? `?stichtag=${stichtag}` : '')),

  /**
   * Die Werte mit ihren Fassungen und der Herkunft je Fassung. `von`/`bis` sind Tage
   * (JJJJ-MM-TT, der letzte einschließlich); `fassungen` `wirksam` (Vorgabe) oder `alle`.
   */
  bezugswertEingeben: (id: string, body: { periode: string; wert: string }) =>
    request<BezugswertAntwort>(`/api/v1/bezugsgroessen/${encodeURIComponent(id)}/werte`, { method: 'POST', body: JSON.stringify(body) }),
  bezugswertBerichtigen: (id: string, periode: string, body: { wert: string; begruendung: string }) =>
    request<BezugswertAntwort>(`/api/v1/bezugsgroessen/${encodeURIComponent(id)}/werte/${encodeURIComponent(periode)}/berichtigung`, { method: 'POST', body: JSON.stringify(body) }),
  ablesungen: (kz: string) => request<Ablesung[]>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen`),
  ablesungEintragen: (kz: string, body: { zeitpunkt: string; stand: string; zuordnung_monat: string | null }) =>
    request<AblesungAntwort>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen`, { method: 'POST', body: JSON.stringify(body) }),
  ablesungBerichtigen: (kz: string, zeitpunkt: string, body: { stand: string; zuordnung_monat: string | null; begruendung: string }) =>
    request<AblesungAntwort>(`/api/v1/messstellen/${encodeURIComponent(kz)}/ablesungen/${encodeURIComponent(zeitpunkt)}/berichtigung`, { method: 'POST', body: JSON.stringify(body) }),

  bezugsKanaele: (id: string) => request<BezugsKanalAuswahl[]>(`/api/v1/bezugsgroessen/${id}/kanalbindung/kanaele`),
  kanalbindungen: (id: string) => request<BezugsKanalbindung[]>(`/api/v1/bezugsgroessen/${id}/kanalbindung`),
  kanalBinden: (id: string, body: BezugsKanalAnfrage) => request<BezugsKanalbindung>(`/api/v1/bezugsgroessen/${id}/kanalbindung`, { method: 'POST', body: JSON.stringify(body) }),
  kanalBeenden: (id: string, bindung: string, bis: string) => request<BezugsKanalbindung>(`/api/v1/bezugsgroessen/${id}/kanalbindung/${bindung}/beenden`, { method: 'POST', body: JSON.stringify({ bis }) }),
  /** AP-17 IP-12c: Wetter-Archiv an der Gradtagzahl — lesen, binden (kein Abruf), lösen (Werte bleiben). */
  wetterbezug: (id: string) => request<Wetterbezug>(`/api/v1/bezugsgroessen/${id}/wetterbezug`),
  wetterBinden: (id: string, body: WetterbezugAnfrage) => request<Wetterbezug>(`/api/v1/bezugsgroessen/${id}/wetterbezug`, { method: 'PUT', body: JSON.stringify(body) }),
  wetterLoesen: (id: string) => request<void>(`/api/v1/bezugsgroessen/${id}/wetterbezug`, { method: 'DELETE' }),
  /** AP-17 IP-12c: die Zeile „Wetter“ am Standort. */
  standortWetter: (standortId: string) => request<StandortWetter>(`/api/v1/standorte/${standortId}/wetter`),
  bezugsgroesseWerte: (id: string, abfrage: { von?: string; bis?: string; fassungen?: BezugsgroesseLesart } = {}) => {
    const q = new URLSearchParams();
    if (abfrage.von) q.set('von', abfrage.von);
    if (abfrage.bis) q.set('bis', abfrage.bis);
    if (abfrage.fassungen) q.set('fassungen', abfrage.fassungen);
    const s = q.toString();
    return request<BezugsgroesseWerte>(`/api/v1/bezugsgroessen/${id}/werte${s ? `?${s}` : ''}`);
  },
  /**
   * Die Berichte, die die Person lesen darf (AP-12 IP-7); Ablehnungen tragen `BerichtFehlerCode`. `abruf` ist der
   * Augenblick der Route - die Uhr der Zeitraum-Wahl beim Anlegen (Konzept Nachweisen n1, Befund 3).
   */
  /** Mit `archiviert: true` auch die archivierten Berichte (Konzept Nachweisen n1, C8: die Zeile „Archiviert · n“). */
  berichte: (o: { archiviert?: boolean } = {}) => request<{ berichte: Bericht[]; abruf: string }>(`/api/v1/berichte${o.archiviert ? '?archiviert=true' : ''}`),
  /** AP-17 IP-17: laufende Bezugsbasen nach Zustand und die fälligen Überprüfungen — Frist beim Abruf abgeleitet. */
  bezugsbasisUebersicht: () => request<BezugsbasisUebersicht>(`/api/v1/bezugsbasen/uebersicht`),
  /** AP-18 IP-19: Ziele und Maßnahmen — Zähler je Art und die fälligen Vorgänge, beim Abruf abgeleitet (F1–F3, W7). */
  verbesserungUebersicht: () => request<VerbesserungUebersicht>(`/api/v1/verbesserung/uebersicht`),
  /**
   * AP-17 IP-20: der Vergleich mit der Bezugsbasis (Leser IP-19, §16) — je Monat roh ohne Urteil und bereinigt mit
   * Band; ohne `basis` die laufende, ohne `von`/`bis` die zwölf abgeschlossenen Monate vor dem laufenden.
   */
  bezugsbasisVergleich: (kennzahlId: string, wahl: BezugsbasisVergleichWahl = {}) => {
    const q = new URLSearchParams(
      (['basis', 'von', 'bis'] as const).flatMap((k) => (wahl[k] ? [[k, wahl[k]] as [string, string]] : [])),
    ).toString();
    return request<BezugsbasisVergleich>(`/api/v1/kennzahlen/${kennzahlId}/vergleich${q ? `?${q}` : ''}`);
  },
  /** Legt den Bericht an und bildet seinen Entwurf. */
  berichtAnlegen: (body: BerichtAnlegen) =>
    request<Bericht>(`/api/v1/berichte`, { method: 'POST', body: JSON.stringify(body) }),
  bericht: (kennung: string) => request<BerichtDetail>(`/api/v1/berichte/${kennung}`),
  /** Der Entwurf nach der D4-Prüfung, nötigenfalls neu gebildet. */
  berichtEntwurf: (kennung: string) => request<BerichtEntwurf>(`/api/v1/berichte/${kennung}/entwurf`),
  berichtVergleich: (kennung: string, gegen: number) =>
    request<BerichtVergleich>(`/api/v1/berichte/${kennung}/entwurf/vergleich?gegen=${gegen}`),
  /** Gibt genau den gesehenen Entwurf frei (F2); dieselbe Freigabe noch einmal ist derselbe Stand (F5, 200). */
  berichtFreigeben: (kennung: string, entwurfDatenstand: string) =>
    request<BerichtStand>(`/api/v1/berichte/${kennung}/freigeben`, {
      method: 'POST',
      body: JSON.stringify({ entwurf_datenstand: entwurfDatenstand }),
    }),
  berichtStand: (kennung: string, nr: number) => request<BerichtStand>(`/api/v1/berichte/${kennung}/staende/${nr}`),
  /**
   * AP-16 IP-25: die Datei eines Stands (`GET …/staende/{nr}/pdf|csv`, AP-12 IP-10/IP-11) — nur aus dem Abzug, jeder Abruf
   * protokolliert (`bericht_abgerufen`). Ein Entwurf hat keine Datei (EW4).
   */
  berichtDatei: async (kennung: string, nr: number, format: 'pdf' | 'csv'): Promise<Blob> => {
    const token = await freshToken();
    const res = await fetch(`${API_BASE}/api/v1/berichte/${kennung}/staende/${nr}/${format}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...bereichKopf(`/api/v1/berichte/${kennung}/staende/${nr}/${format}`),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw new ApiError(res.status, (body as { message?: string } | undefined)?.message ?? 'Die Datei konnte nicht abgerufen werden.', body);
    }
    return res.blob();
  },
  /** Verwirft einen offenen Anstoß — die Begründung ist Pflicht (10 bis 500 Zeichen). */
  berichtAnstossVerwerfen: (kennung: string, id: string, begruendung: string) =>
    request<BerichtAnstoss>(`/api/v1/berichte/${kennung}/anstoesse/${id}/verwerfen`, {
      method: 'POST',
      body: JSON.stringify({ begruendung }),
    }),
  /**
   * „Nein, Stand n behalten“ (Konzept Nachweisen n1, Entscheid 16): die gesehenen offenen Anstöße mit EINEM Grund in
   * einer Transaktion - alle oder keiner (409 `anstoss_nicht_offen` mit `anstoss_id`).
   */
  berichtAnstoesseVerwerfen: (kennung: string, anstossIds: readonly string[], begruendung: string) =>
    request<{ anstoesse: BerichtAnstoss[] }>(`/api/v1/berichte/${kennung}/anstoesse/verwerfen`, {
      method: 'POST',
      body: JSON.stringify({ anstoss_ids: anstossIds, begruendung }),
    }),
  berichtArchivieren: (kennung: string) =>
    request<Bericht>(`/api/v1/berichte/${kennung}/archivieren`, { method: 'POST' }),
  /**
   * Welche freigegebenen Berichtsstände eine Strukturänderung an `objekt` mit Wirkung ab `giltAb` träfe
   * (AP-12 IP-9). 403, wenn die Person keinen Bericht lesen darf — die Folgen-Karten zeigen dann nichts.
   */
  berichteBetroffen: (objekt: string, giltAb: string, anlass: BerichtStrukturAnlass) =>
    request<BerichteBetroffen>(
      `/api/v1/berichte/betroffen?${new URLSearchParams({ objekt, gilt_ab: giltAb, anlass }).toString()}`,
    ),
  /** UEMS AP-16 IP-5: der Betrachtungsumfang am Stichtag; ohne Fassung die ungespeicherte Vorgabe (`fassung: null`). */
  bewertungUmfang: (am?: string) =>
    request<BewertungUmfang>(`/api/v1/unternehmen/bewertung/umfang${am ? `?am=${encodeURIComponent(am)}` : ''}`),
  /** Speichert den Umfang als neue Fassung; identischer Inhalt liefert dieselbe Fassung. */
  bewertungUmfangSpeichern: (body: BewertungUmfangSpeichern) =>
    request<BewertungUmfang>(`/api/v1/unternehmen/bewertung/umfang`, { method: 'PUT', body: JSON.stringify(body) }),
  /** UEMS AP-16 IP-12: Rangliste mit Urteil und Vorschlag; die Einstufung bleibt eine Entscheidung einer Person. */
  bewertungRangliste: (von: string, bis: string) =>
    request<BewertungRangliste>(`/api/v1/unternehmen/bewertung/rangliste?${new URLSearchParams({ von, bis }).toString()}`),
  /** UEMS AP-16 IP-13: Messabdeckung je Einsatz und je Ort — gemessen, geplant (Menge null, nie 0), Ersatz, ungemessen. */
  bewertungMessabdeckung: (von: string, bis: string) =>
    request<BewertungMessabdeckung>(`/api/v1/unternehmen/bewertung/messabdeckung?${new URLSearchParams({ von, bis }).toString()}`),
  /** UEMS AP-16 IP-15: die Messmittel-Angaben des Einbaus; ohne Angabe `nicht_erhoben` (G3). */
  geraetMessmittel: (id: string) => request<MessmittelAngaben>(`/api/v1/geraete/${id}/messmittel`),
  /** Trägt die ganze Angabe ein; der Beleg ist ein Verweis mit SHA-256 — die Datei verlässt den Browser nie (G2). */
  geraetMessmittelEintragen: (id: string, body: MessmittelEintrag) =>
    request<MessmittelAngaben>(`/api/v1/geraete/${id}/messmittel`, { method: 'PUT', body: JSON.stringify(body) }),
  /** UEMS AP-16 IP-17: neue Toleranz-Fassung einer Vergleichsquelle; gilt ab dem laufenden Monat, nie rückwirkend. */
  vergleichToleranzEintragen: (messstelleId: string, quelleId: string, body: { prozent: string; begruendung: string }) =>
    request<VergleichToleranzFassung>(`/api/v1/messstellen/${messstelleId}/quellen/${quelleId}/toleranz`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  bewertungKriterien: () => request<BewertungKriterienFassung>(`/api/v1/unternehmen/bewertung/kriterien`),
  bewertungKriterienSpeichern: (body: BewertungKriterienSpeichern) =>
    request<BewertungKriterienFassung>(`/api/v1/unternehmen/bewertung/kriterien`, { method: 'PUT', body: JSON.stringify(body) }),
  /** Konzept Auswerten a1, Befund 6: alle Fassungen, auch eine beantragte (Vier-Augen) — sie wartet auf eine zweite Person. */
  bewertungKriterienHistorie: () =>
    request<{ fassungen: BewertungKriterienFassung[] }>(`/api/v1/unternehmen/bewertung/kriterien/fassungen`),
  /** Die zweite Person gibt eine beantragte Fassung frei (403 `zweite_person_noetig`, 409 `bereits_entschieden`). */
  bewertungKriterienFreigeben: (nummer: number) =>
    request<BewertungKriterienFassung>(`/api/v1/unternehmen/bewertung/kriterien/${nummer}/freigeben`, { method: 'POST', body: JSON.stringify({}) }),
  /** Die zweite Person lehnt ab — mit Begründung (422 `begruendung_fehlt`). */
  bewertungKriterienAblehnen: (nummer: number, begruendung: string) =>
    request<BewertungKriterienFassung>(`/api/v1/unternehmen/bewertung/kriterien/${nummer}/ablehnen`, {
      method: 'POST', body: JSON.stringify({ begruendung }),
    }),
  /** UEMS AP-16 IP-4: die Energieeinsätze, laufende zuerst; Ablehnungen tragen `EnergieeinsatzFehlerCode`. */
  energieeinsaetze: () => request<{ energieeinsaetze: Energieeinsatz[] }>(`/api/v1/unternehmen/energieeinsaetze`),
  /** Prozesse ohne laufenden Einsatz für Strom — die Vorschläge des Prozess-Pickers. */
  energieeinsatzVorschlaege: () =>
    request<{ vorschlaege: EnergieeinsatzVorschlag[] }>(`/api/v1/unternehmen/energieeinsaetze/vorschlaege`),
  energieeinsatz: (id: string) => request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze/${id}`),
  energieeinsatzAnlegen: (body: EnergieeinsatzAnlegen) =>
    request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze`, { method: 'POST', body: JSON.stringify(body) }),
  energieeinsatzBearbeiten: (id: string, body: EnergieeinsatzBearbeiten) =>
    request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  energieeinsatzBeenden: (id: string, body: { grund: string; gueltig_bis?: string }) =>
    // Server und Vertrag kennen nur POST (`EnergieeinsatzController.beenden`); mit PUT antwortete die Route 405.
    request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze/${id}/beenden`, { method: 'POST', body: JSON.stringify(body) }),
  /** Verantwortlich ist eine Zuständigkeit, kein Recht (R14); `null` hebt sie auf. */
  energieeinsatzVerantwortlicher: (id: string, verantwortlichSub: string | null) =>
    request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze/${id}/verantwortlicher`, {
      method: 'PUT',
      body: JSON.stringify({ verantwortlich_sub: verantwortlichSub }),
    }),
  /** Ersetzt die Einflussgrößen; die Vorgänger bleiben im Protokoll. */
  energieeinsatzEinflussgroessen: (id: string, einflussgroessen: EnergieeinsatzEinfluss[]) =>
    request<Energieeinsatz>(`/api/v1/unternehmen/energieeinsaetze/${id}/einflussgroessen`, {
      method: 'PUT',
      body: JSON.stringify({ einflussgroessen }),
    }),
  energieeinsatzProtokoll: (id: string) =>
    request<{ aenderungen: EnergieeinsatzAenderung[] }>(`/api/v1/unternehmen/energieeinsaetze/${id}/protokoll`),
  energieeinsatzEinstufungen: (id: string) =>
    request<EnergieeinsatzEinstufungHistorie>(`/api/v1/unternehmen/energieeinsaetze/${id}/einstufungen`),
  energieeinsatzEinstufen: (id: string, body: EnergieeinsatzEinstufungSpeichern) =>
    request<EnergieeinsatzEinstufungFassung>(`/api/v1/unternehmen/energieeinsaetze/${id}/einstufung`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  energieeinsatzEinstufungBestaetigen: (id: string) =>
    request<EnergieeinsatzEinstufungFassung>(`/api/v1/unternehmen/energieeinsaetze/${id}/einstufung/bestaetigen`, { method: 'POST' }),
  /** UEMS AP-16 IP-19: alle Messbedarfe des Einsatzes — eingelöste und verworfene bleiben lesbar. */
  messbedarfe: (einsatzId: string) =>
    request<{ messbedarfe: Messbedarf[] }>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf`),
  /**
   * UEMS AP-16 P1: die Messbedarfe aller Einsätze, die die Anfrage sieht — mit `standort` nur die, deren strukturierter Ort
   * heute dort hängt (ein Bedarf nur mit Ort-Wortlaut steht an keinem Standort).
   */
  messbedarfeAlle: (standort?: string) =>
    request<{ messbedarfe: Messbedarf[] }>(`/api/v1/unternehmen/messbedarf${standort ? `?standort=${encodeURIComponent(standort)}` : ''}`),
  /** Bearbeitet einen offenen Bedarf (ersetzt alle Felder); 409 `messbedarf_abgeschlossen` bzw. `berichts_belege`. */
  messbedarfBearbeiten: (einsatzId: string, messbedarfId: string, body: MessbedarfAnlegen) =>
    request<Messbedarf>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf/${messbedarfId}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  /** Das unveränderliche Protokoll des Bedarfs: Akteur, Zeitpunkt, Vorher-/Nachher-Stand. */
  messbedarfProtokoll: (einsatzId: string, messbedarfId: string) =>
    request<{ aenderungen: MessbedarfAenderung[] }>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf/${messbedarfId}/protokoll`),
  /** Erfasst einen offenen Messbedarf; Recht `energieeinsatz.verwalten`. */
  messbedarfErfassen: (einsatzId: string, body: MessbedarfAnlegen) =>
    request<Messbedarf>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf`, { method: 'POST', body: JSON.stringify(body) }),
  /** Löst ein — nur mit einer eingerichteten Messstelle (sonst 422 `messstelle_nicht_eingerichtet`). */
  messbedarfEinloesen: (einsatzId: string, messbedarfId: string, messstelleId: string) =>
    request<Messbedarf>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf/${messbedarfId}/einloesen`, {
      method: 'POST', body: JSON.stringify({ messstelle_id: messstelleId }),
    }),
  /** Verwirft mit Pflicht-Begründung; der Bedarf bleibt lesbar. */
  messbedarfVerwerfen: (einsatzId: string, messbedarfId: string, begruendung: string) =>
    request<Messbedarf>(`/api/v1/unternehmen/energieeinsaetze/${einsatzId}/messbedarf/${messbedarfId}/verwerfen`, {
      method: 'POST', body: JSON.stringify({ begruendung }),
    }),
  // ------------------------------------------------------------------ Energiemanagement (UEMS AP-19 IP-6/IP-7/IP-8)
  /** IP-6 (PA1): die Personen im Energiemanagement — aktive zuerst; Recht `energiemanagement.ansehen`. */
  energiemanagementPersonen: () => request<{ personen: EnergiemanagementPerson[] }>('/api/v1/energiemanagement/personen'),
  /** IP-6 (PA1): Person erfassen, auch ohne Konto; Recht `energiemanagement.verwalten` am Unternehmen. */
  energiemanagementPersonAnlegen: (body: EnergiemanagementPersonAnlegen) =>
    request<{ person: EnergiemanagementPerson }>('/api/v1/energiemanagement/personen', { method: 'POST', body: JSON.stringify(body) }),
  /** IP-6 (PA2, PA3): die Aufgaben am Tag mit der Leitung — nur unternehmensweit. */
  energiemanagementAufgaben: (tag?: string) =>
    request<EnergiemanagementAufgaben>(`/api/v1/energiemanagement/aufgaben${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  /**
   * PA3, DK3: die Leitung am Tag für die Freigabe mit Leitungs-Pflicht - Recht `energiemanagement.freigeben` am Standort
   * (ohne Standort am Unternehmen), auch ohne die Aufgaben unternehmensweit zu lesen (Konzept Nachweisen n1, Befund A4).
   */
  energiemanagementLeitung: (tag?: string | null, standort?: string | null) => {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    if (standort) q.set('standort', standort);
    const s = q.toString();
    return request<EnergiemanagementLeitung>(`/api/v1/energiemanagement/leitung${s ? `?${s}` : ''}`);
  },
  /** IP-6 (PA2): Aufgabe zuordnen — bei `unternehmensleitung` ohne „entschieden von“. */
  energiemanagementAufgabeZuordnen: (body: EnergiemanagementAufgabeZuordnen) =>
    request<EnergiemanagementZuordnung>('/api/v1/energiemanagement/aufgaben', { method: 'POST', body: JSON.stringify(body) }),
  /** IP-6 (PA1): eine Person mit ihrem Verlauf (jede Konto-Verknüpfung steht darin). */
  energiemanagementPerson: (id: string) =>
    request<EnergiemanagementPersonMitVerlauf>(`/api/v1/energiemanagement/personen/${encodeURIComponent(id)}`),
  /** IP-6 (PA1, PA5): der ganze Stand — Konto verknüpfen oder mit „bis“ beenden verlangt eine Begründung. */
  energiemanagementPersonAendern: (id: string, body: EnergiemanagementPersonAendern) =>
    request<EnergiemanagementPersonMitVerlauf>(`/api/v1/energiemanagement/personen/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  /** IP-6 (PA2): Zuordnung beenden — einmal, der letzte Tag zählt mit. */
  energiemanagementAufgabeBeenden: (id: string, body: EnergiemanagementAufgabeBeenden) =>
    request<EnergiemanagementZuordnung>(`/api/v1/energiemanagement/aufgaben/${encodeURIComponent(id)}/beenden`, { method: 'POST', body: JSON.stringify(body) }),
  /** IP-10 (PA4): „Wer ist wofür verantwortlich“ am Tag — gelesen, nichts kopiert. */
  energiemanagementVerantwortung: (tag?: string) =>
    request<EnergiemanagementVerantwortung>(`/api/v1/energiemanagement/verantwortung${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  /** IP-8 (VZ1–VZ4): das Verzeichnis zum Abruf — ein Leser über alle Quellen, gefiltert nach Gruppe, Tag, Person. */
  energiemanagementVerzeichnis: (filter: EnergiemanagementVerzeichnisFilter = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => !!e[1])).toString();
    return request<EnergiemanagementVerzeichnis>(`/api/v1/energiemanagement/verzeichnis${q ? `?${q}` : ''}`);
  },
  /** IP-8 (KS2): dasselbe Verzeichnis als CSV-Datei (`format=csv`) — ein Abruf, nichts wird verschickt. */
  energiemanagementVerzeichnisCsv: async (filter: EnergiemanagementVerzeichnisFilter = {}): Promise<Blob> => {
    const q = new URLSearchParams([...Object.entries(filter).filter((e): e is [string, string] => !!e[1]), ['format', 'csv']]).toString();
    const token = await freshToken();
    const res = await fetch(`${API_BASE}/api/v1/energiemanagement/verzeichnis?${q}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...bereichKopf(`/api/v1/energiemanagement/verzeichnis?${q}`),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw new ApiError(res.status, (body as { message?: string } | undefined)?.message ?? 'Die Datei konnte nicht abgerufen werden.', body);
    }
    return res.blob();
  },
  /** Nachweisen n1, Entscheid 7: die Mappen, die jüngste zuerst (nur unternehmensweit). */
  energiemanagementMappen: () => request<{ mappen: EnergiemanagementMappe[] }>('/api/v1/energiemanagement/mappen'),
  energiemanagementMappe: (id: string) =>
    request<EnergiemanagementMappe>(`/api/v1/energiemanagement/mappen/${encodeURIComponent(id)}`),
  /** Nachweisen n1, Entscheid 7: Unterlagen zusammenstellen - PDF mit Inhaltsverzeichnis und Verzeichnis-CSV. */
  energiemanagementMappeAnlegen: (body: EnergiemanagementMappeAnlegen) =>
    request<EnergiemanagementMappe>('/api/v1/energiemanagement/mappen', { method: 'POST', body: JSON.stringify(body) }),
  /** Nachweisen n1, Entscheid 7: eine Datei der Mappe - jeder Abruf protokolliert, nach 30 Tagen 410. */
  energiemanagementMappeDatei: async (id: string, format: 'pdf' | 'csv'): Promise<Blob> => {
    const pfad = `/api/v1/energiemanagement/mappen/${encodeURIComponent(id)}/${format}`;
    const token = await freshToken();
    const res = await fetch(`${API_BASE}${pfad}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...bereichKopf(pfad) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw new ApiError(res.status, (body as { message?: string } | undefined)?.message ?? 'Die Datei konnte nicht abgerufen werden.', body);
    }
    return res.blob();
  },
  /** Nachweisen n1, Entscheid 5: die Vermerke „Trifft bei uns zurzeit nicht zu“, geltende zuerst. */
  energiemanagementTeilVermerke: () => request<EnergiemanagementTeilVermerke>('/api/v1/energiemanagement/teil-vermerke'),
  /** Nachweisen n1, Entscheid 5: einen Teil als „trifft bei uns zurzeit nicht zu“ festhalten (409 `vermerk_besteht`). */
  energiemanagementTeilVermerkAnlegen: (body: EnergiemanagementTeilVermerkAnlegen) =>
    request<EnergiemanagementTeilVermerk>('/api/v1/energiemanagement/teil-vermerke', { method: 'POST', body: JSON.stringify(body) }),
  /** Nachweisen n1, Entscheid 5: einen Vermerk aufheben; er bleibt lesbar. */
  energiemanagementTeilVermerkAufheben: (id: string) =>
    request<EnergiemanagementTeilVermerk>(`/api/v1/energiemanagement/teil-vermerke/${encodeURIComponent(id)}/aufheben`, { method: 'POST' }),
  /** IP-21 (WV1–WV4): die Wiedervorlage — fällig und Vorschau über alle Objekte, beim Abruf abgeleitet. */
  energiemanagementWiedervorlage: () => request<Wiedervorlage>('/api/v1/energiemanagement/wiedervorlage'),
  /** Konzept Wiedervorlage w1: „Zuletzt erledigt“, die letzten Entscheidungen, die eine Frist beendet oder neu begonnen haben. */
  energiemanagementWiedervorlageZuletzt: () => request<WiedervorlageZuletzt>('/api/v1/energiemanagement/wiedervorlage/zuletzt'),
  /** IP-21 (E10 = A): dieselben Zeilen als Kalender-Abzug (`format=ics`) — ein Abruf, nichts wird verschickt. */
  energiemanagementWiedervorlageIcs: async (): Promise<Blob> => {
    const token = await freshToken();
    const res = await fetch(`${API_BASE}/api/v1/energiemanagement/wiedervorlage?format=ics`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...bereichKopf('/api/v1/energiemanagement/wiedervorlage?format=ics'),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw new ApiError(res.status, (body as { message?: string } | undefined)?.message ?? 'Die Datei konnte nicht abgerufen werden.', body);
    }
    return res.blob();
  },
  /** AP-19 IP-23 (MG4–MG6): Sitzung, Beschlüsse und ihre Folgen mit dem Zustand von heute; Recht `energiemanagement.ansehen`. */
  managementbewertung: (kennung: string) =>
    request<Managementbewertung>(`/api/v1/energiemanagement/managementbewertungen/${encodeURIComponent(kennung)}`),
  /** MG4: die Sitzung festhalten (ersetzt die vorige Angabe) — bis zur Freigabe; `energiemanagement.verwalten`. */
  managementbewertungSitzung: (kennung: string, body: ManagementbewertungSitzungFesthalten) =>
    request<Managementbewertung>(`/api/v1/energiemanagement/managementbewertungen/${encodeURIComponent(kennung)}/sitzung`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** MG5: einen Beschluss festhalten (nächste Nr.) — nach der Sitzung, bis zur Freigabe. */
  managementbewertungBeschluss: (kennung: string, body: ManagementbewertungBeschlussFesthalten) =>
    request<Managementbewertung>(`/api/v1/energiemanagement/managementbewertungen/${encodeURIComponent(kennung)}/beschluesse`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** MG5: Beschluss `nr` ändern — bis zur Freigabe; die Nr. bleibt. */
  managementbewertungBeschlussAendern: (kennung: string, nr: number, body: ManagementbewertungBeschlussFesthalten) =>
    request<Managementbewertung>(`/api/v1/energiemanagement/managementbewertungen/${encodeURIComponent(kennung)}/beschluesse/${nr}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** MG6: eine Folge mit Beschluss `nr` verknüpfen — nach der Freigabe, nur anhängen; die Maßnahme verknüpft sich selbst. */
  managementbewertungFolge: (kennung: string, nr: number, body: ManagementbewertungFolgeVerknuepfen) =>
    request<Managementbewertung>(`/api/v1/energiemanagement/managementbewertungen/${encodeURIComponent(kennung)}/beschluesse/${nr}/folgen`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** IP-7 (DK1): die Dokumente im Zaun, je mit der Überprüfung beim Abruf. */
  energiemanagementDokumente: () => request<{ dokumente: EnergiemanagementDokumentKurz[] }>('/api/v1/energiemanagement/dokumente'),
  energiemanagementDokument: (id: string) => request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}`),
  /** IP-7 (DK7, W5): Anwendungsbereich neben dem Betrachtungsumfang der energetischen Bewertung — ohne Urteil. */
  energiemanagementVergleich: (id: string) => request<EnergiemanagementVergleich>(`/api/v1/energiemanagement/dokumente/${id}/vergleich`),
  /** IP-14 (R7): der Abschnitt „Nachweise“ am Energieeinsatz — der Zaun folgt dem Standort des Einsatzes, sonst 404. */
  energiemanagementNachweiseAmEinsatz: (id: string) =>
    request<EnergiemanagementNachweiseAmEinsatz>(`/api/v1/energiemanagement/energieeinsaetze/${encodeURIComponent(id)}/nachweise`),
  /** IP-14 (R8): die Nachweise an einer Person und an ihren Aufgaben — ohne Standort, wer nur Standorte liest, liest eine leere Liste. */
  energiemanagementNachweiseDerPerson: (id: string) =>
    request<EnergiemanagementNachweiseDerPerson>(`/api/v1/energiemanagement/personen/${encodeURIComponent(id)}/nachweise`),
  energiemanagementDokumentAnlegen: (body: EnergiemanagementDokumentAnlegen) =>
    request<EnergiemanagementDokument>('/api/v1/energiemanagement/dokumente', { method: 'POST', body: JSON.stringify(body) }),
  /** IP-7 (DK2, G3): Fassung entwerfen — Wortlaut oder Verweis; ein offener Entwurf wird überschrieben. */
  energiemanagementFassungEntwerfen: (id: string, body: EnergiemanagementFassungEntwerfen) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/fassungen`, { method: 'POST', body: JSON.stringify(body) }),
  /** IP-7 (DK3): Freigabe beantragen — nur mit Vier-Augen. */
  energiemanagementFassungBeantragen: (id: string, nr: number, body: EnergiemanagementEntscheid) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/fassungen/${nr}/beantragen`, { method: 'POST', body: JSON.stringify(body) }),
  /** IP-7 (DK3, DK4): freigeben — mit „entschieden von“; bei Vier-Augen bestätigt eine zweite Person. */
  energiemanagementFassungFreigeben: (id: string, nr: number, body: EnergiemanagementEntscheid) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/fassungen/${nr}/freigeben`, { method: 'POST', body: JSON.stringify(body) }),
  /** DK5: „geprüft, bleibt“ an der gültigen Fassung einer Vorgabe; die Überprüfung beginnt neu. Recht `energiemanagement.freigeben`. */
  energiemanagementDokumentGeprueft: (id: string, body: EnergiemanagementGeprueft) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/geprueft`, { method: 'POST', body: JSON.stringify(body) }),
  /** DK3 (Entscheid 11): die zweite Person lehnt einen Antrag mit Begründung ab; danach ist ein neuer Entwurf möglich. */
  energiemanagementFassungAblehnen: (id: string, nr: number, begruendung: string) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/fassungen/${nr}/ablehnen`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  /** DK6 (Entscheid 12): bekannt gemacht an einem Kreis über EINEN Weg - mehrere Wege sind mehrere Einträge. */
  energiemanagementBekanntmachen: (id: string, body: EnergiemanagementBekanntmachen) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/bekanntmachungen`, { method: 'POST', body: JSON.stringify(body) }),
  /** DK8 (Entscheid 12): aufheben - Recht `energiemanagement.freigeben`; das Dokument bleibt mit allen Fassungen lesbar. */
  energiemanagementDokumentAufheben: (id: string, body: EnergiemanagementAufheben) =>
    request<EnergiemanagementDokument>(`/api/v1/energiemanagement/dokumente/${id}/aufheben`, { method: 'POST', body: JSON.stringify(body) }),
  /** AP-08 E8 (Entscheid 11): ob bei diesem Unternehmen zwei Personen freigeben - das Blatt zeigt es vorab. */
  unternehmenVierAugen: () => request<UnternehmenVierAugen>('/api/v1/unternehmen/vieraugen'),
  /** AP-19 IP-18 (IA4): das Auditprogramm — alle internen Audits und das nächste fällige; Recht `energiemanagement.ansehen`. */
  energiemanagementAudits: (tag?: string) =>
    request<InternesAuditprogramm>(`/api/v1/energiemanagement/audits${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  energiemanagementAudit: (id: string) => request<InternesAuditMitVerlauf>(`/api/v1/energiemanagement/audits/${encodeURIComponent(id)}`),
  /** IA1: planen — `energiemanagement.verwalten` am Unternehmen. */
  energiemanagementAuditPlanen: (body: InternesAuditStand) =>
    request<InternesAuditMitVerlauf>('/api/v1/energiemanagement/audits', { method: 'POST', body: JSON.stringify(body) }),
  energiemanagementAuditDurchgefuehrt: (id: string, am: string) =>
    request<InternesAuditMitVerlauf>(`/api/v1/energiemanagement/audits/${encodeURIComponent(id)}/durchgefuehrt`, { method: 'POST', body: JSON.stringify({ am }) }),
  /** IA2, IA5: ein Hinweis — „festgestellt von“ ist die Person, die prüft. */
  energiemanagementAuditHinweis: (id: string, body: { wortlaut: string; festgestellt_von: string; am?: string | null }) =>
    request<InternesAuditMitVerlauf>(`/api/v1/energiemanagement/audits/${encodeURIComponent(id)}/hinweise`, { method: 'POST', body: JSON.stringify(body) }),
  /** IA3: abschließen — `energiemanagement.freigeben`; danach unveränderlich. */
  energiemanagementAuditAbschliessen: (id: string, body: InternesAuditAbschliessen) =>
    request<InternesAuditMitVerlauf>(`/api/v1/energiemanagement/audits/${encodeURIComponent(id)}/abschliessen`, { method: 'POST', body: JSON.stringify(body) }),
  energiemanagementAuditAbsagen: (id: string, begruendung: string) =>
    request<InternesAuditMitVerlauf>(`/api/v1/energiemanagement/audits/${encodeURIComponent(id)}/absagen`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
  /** AP-19 IP-19 (FS1): offene zuerst, am längsten überfällig oben, dann abgeschlossene. */
  energiemanagementFeststellungen: (tag?: string) =>
    request<FeststellungListe>(`/api/v1/energiemanagement/feststellungen${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),
  energiemanagementFeststellung: (id: string) =>
    request<FeststellungMitVerlauf>(`/api/v1/energiemanagement/feststellungen/${encodeURIComponent(id)}`),
  energiemanagementFeststellungErfassen: (body: FeststellungErfassen) =>
    request<FeststellungMitVerlauf>('/api/v1/energiemanagement/feststellungen', { method: 'POST', body: JSON.stringify(body) }),
  /** FS2: Einträge nur anhängen — immer die Aussage einer Person an einem Tag. */
  energiemanagementFeststellungEintrag: (id: string, body: FeststellungEintragFesthalten) =>
    request<FeststellungMitVerlauf>(`/api/v1/energiemanagement/feststellungen/${encodeURIComponent(id)}/eintraege`, { method: 'POST', body: JSON.stringify(body) }),
  /** FS4 (`wirksam · nicht_wirksam`) über `…/wirksamkeit`, FS5 (`ohne_massnahme · zurueckgenommen`) über `…/abschliessen`, mit Vier-Augen `…/wirksamkeit/beantragen`. */
  energiemanagementFeststellungStand: (id: string, weg: 'wirksamkeit' | 'abschliessen' | 'wirksamkeit/beantragen', body: FeststellungStandFesthalten) =>
    request<FeststellungMitVerlauf>(`/api/v1/energiemanagement/feststellungen/${encodeURIComponent(id)}/${weg}`, { method: 'POST', body: JSON.stringify(body) }),
  energiemanagementFeststellungFreigeben: (id: string) =>
    request<FeststellungMitVerlauf>(`/api/v1/energiemanagement/feststellungen/${encodeURIComponent(id)}/wirksamkeit/freigeben`, { method: 'POST', body: JSON.stringify({}) }),
  energiemanagementFeststellungAblehnen: (id: string, begruendung: string) =>
    request<FeststellungMitVerlauf>(`/api/v1/energiemanagement/feststellungen/${encodeURIComponent(id)}/wirksamkeit/ablehnen`, { method: 'POST', body: JSON.stringify({ begruendung }) }),
};

// An DASSELBE Objekt einhängen, nur was fehlt: ein Test-Ersatz (`vi.mock` mit eigener Methode) bleibt stehen.
for (const [name, route] of Object.entries(weitere)) {
  if (!(name in einstieg)) (einstieg as Record<string, unknown>)[name] = route;
}

/** Die Routen dieses Moduls (alles außer dem ersten Bild). */
export type ApiWeitere = typeof weitere;

/** Das eine `api`-Objekt mit allen Routen. */
export const api = einstieg as typeof einstieg & ApiWeitere;
