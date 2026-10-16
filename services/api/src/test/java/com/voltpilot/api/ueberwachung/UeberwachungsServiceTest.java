package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.InstanzZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Zustandsübergang der Überwachung rein (Alerting Scheibe 1, §6.5, §6.4 Nr. 1/4) - keine
 * Datenbank; {@link UeberwachungSiteScopeIT} prüft denselben Lebenszyklus gegen echte Zeilen.
 */
class UeberwachungsServiceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID REGEL = UUID.randomUUID();
    private static final UUID ANLAGE = UUID.randomUUID();
    private static final String BEZUG = "anlage:" + ANLAGE;

    private final UeberwachungRepository repo = mock(UeberwachungRepository.class);
    private final ZustandWerteLeser leser = mock(ZustandWerteLeser.class);
    private final EreignisWerteLeser ereignisLeser = mock(EreignisWerteLeser.class);
    private final AnlagenflussWerteLeser anlagenflussLeser = mock(AnlagenflussWerteLeser.class);
    private final MessreiheWerteLeser messreiheLeser = mock(MessreiheWerteLeser.class);
    private final MengeWerteLeser mengeLeser = mock(MengeWerteLeser.class);
    private final GeldWerteLeser geldLeser = mock(GeldWerteLeser.class);
    private final KennzahlWerteLeser kennzahlLeser = mock(KennzahlWerteLeser.class);
    private final ZaehlungWerteLeser zaehlungLeser = mock(ZaehlungWerteLeser.class);
    private final ZugriffRepository zugriffe = mock(ZugriffRepository.class);
    private final PriceRepository preise = mock(PriceRepository.class);
    private final com.voltpilot.api.repo.PeakShavingRepository peakShaving =
            mock(com.voltpilot.api.repo.PeakShavingRepository.class);
    private final com.voltpilot.api.uems.MessstelleRepository messstellen =
            mock(com.voltpilot.api.uems.MessstelleRepository.class);
    private final com.voltpilot.api.uems.KennzahlService kennzahlen = mock(com.voltpilot.api.uems.KennzahlService.class);
    private final com.voltpilot.api.uems.EnergiezielService energieziele =
            mock(com.voltpilot.api.uems.EnergiezielService.class);
    private final WerteKatalog katalog = new WerteKatalog();
    private final BenachrichtigungAusgang ausgang = mock(BenachrichtigungAusgang.class);
    private final UeberwachungsService dienst = new UeberwachungsService(repo, katalog, leser, ereignisLeser,
            anlagenflussLeser, messreiheLeser, mengeLeser, geldLeser, kennzahlLeser, zaehlungLeser, zugriffe, preise,
            peakShaving, messstellen, kennzahlen, energieziele);

    UeberwachungsServiceTest() {
        dienst.setAusgang(ausgang);
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static UeberwachungZeile regel(String schwere) {
        return new UeberwachungZeile(REGEL, null, 1, "Box meldet sich nicht",
                "box.erreichbar", json("{\"anlage\":\"" + ANLAGE + "\"}"),
                json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"],\"dauer_s\":900,\"erholen_s\":300}"),
                schwere, json("[{\"person\":\"sub-jonas\"}]"), "ab_werk", "system", null, null);
    }

    private void nichtsGesaet() {
        when(repo.anlagenMitAngenommenerBox()).thenReturn(List.of());
        when(repo.anlagenMitDatenquelle()).thenReturn(List.of());
    }

    private void lese(WerteLeser.Lesung lesung) {
        when(leser.lese(any(), any(), any())).thenReturn(lesung);
    }

    @Test
    void unbekanntLoestNieEinenAlarmAusUnbekanntIstKeineNull() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        when(repo.instanz(REGEL, BEZUG)).thenReturn(InstanzZeile.NEU);
        lese(WerteLeser.Lesung.unbekannt());

        dienst.lauf(Instant.now());

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any());
        // Schon "normal" und weiterhin unerfüllt (unbekannt zählt nie als erfüllt): kein Schreiben nötig.
        verify(repo, never()).instanzSpeichern(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void einRueckfallVorAblaufDerDauerLoestKeinenAlarmAus() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant seit = Instant.now().minusSeconds(100); // unter den 900 s Dauer
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", seit, null, null, null, null));
        lese(WerteLeser.Lesung.zustand("erreichbar", Instant.now())); // nicht mehr erfüllt

        dienst.lauf(Instant.now());

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("normal"), eq(null), any(), any(), any(), any());
    }

    @Test
    void ausstehendWirdErstNachAblaufDerDauerZuEinemAlarm() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant jetzt = Instant.now();
        Instant seit = jetzt.minusSeconds(901); // über die 900 s Dauer
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", seit, null, null, null, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt));
        UUID alarmId = UUID.randomUUID();
        when(repo.alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any())).thenReturn(alarmId);
        when(repo.alarm(alarmId)).thenReturn(java.util.Optional.empty());

        dienst.lauf(jetzt);

        verify(repo).alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean(), any());
        verify(ausgang).email(eq("alarm"), eq(alarmId), eq("sub-jonas"), eq("ausgeloest"), eq(0), anyString(),
                anyString(), any(), any());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("aktiv"), eq(jetzt), any(), any(), eq(alarmId), any());
    }

    @Test
    void einHinweisAlarmVersendetKeineEmail() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("hinweis")));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", jetzt.minusSeconds(901), null,
                null, null, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt));
        when(repo.alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any())).thenReturn(UUID.randomUUID());

        dienst.lauf(jetzt);

        verify(ausgang, never()).email(any(), any(), any(), any(), any(), any());
    }

    @Test
    void einRueckfallWaehrendDerErholdauerBleibtDerselbeAlarmOhneNeueNachricht() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant jetzt = Instant.now();
        Instant erholendSeit = jetzt.minusSeconds(60); // unter den 300 s Erholdauer
        UUID offenerAlarm = UUID.randomUUID();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("erholend", erholendSeit, null, null,
                offenerAlarm, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt)); // wieder erfüllt - Rückfall

        dienst.lauf(jetzt);

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("aktiv"), eq(erholendSeit), any(), any(),
                eq(offenerAlarm), any());
    }

    @Test
    void nachDerErholdauerWirdErErledigtOhneGesehenEntscheid3B() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant jetzt = Instant.now();
        Instant erholendSeit = jetzt.minusSeconds(301); // über die 300 s Erholdauer
        UUID offenerAlarm = UUID.randomUUID();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("erholend", erholendSeit, null, null,
                offenerAlarm, null));
        lese(WerteLeser.Lesung.zustand("erreichbar", jetzt)); // nicht mehr erfüllt

        dienst.lauf(jetzt);

        verify(repo).alarmWiederNormal(offenerAlarm, jetzt, true);
        verify(repo, never()).gesehen(any(), any(), any());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("normal"), eq(null), any(), any(), eq(null), any());
    }

    // =================================================================== Scheibe 4: Auswahl (§6.4 "Gilt für")

    private static final UUID ANLAGE2 = UUID.randomUUID();
    private static final String BEZUG2 = "anlage:" + ANLAGE2;

    private static UeberwachungZeile auswahlRegel(String alleJson) {
        return new UeberwachungZeile(REGEL, null, 1, "Box meldet sich nicht", "box.erreichbar",
                json(alleJson), json("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"],\"dauer_s\":0,"
                        + "\"erholen_s\":300}"), "warnung", json("[{\"person\":\"sub-jonas\"}]"), "eigen", "system",
                null, null);
    }

    @Test
    void eineAuswahlErgibtJeAnlageEineEigeneInstanzUndEinenEigenenAlarm() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(auswahlRegel("{\"alle\":\"anlage\"}")));
        when(repo.alleAnlagen()).thenReturn(List.of(ANLAGE, ANLAGE2));
        Instant jetzt = Instant.now();
        // "ausstehend" schon mit seit = jetzt (Dauer 0 ist damit sofort erreicht) - wie die bestehenden
        // Tests dieser Klasse prüft ein Mock den Übergang ausstehend -> aktiv direkt, ohne zwei Takte.
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", jetzt, null, null, null, null));
        when(repo.instanz(REGEL, BEZUG2)).thenReturn(new InstanzZeile("ausstehend", jetzt, null, null, null, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt));
        when(repo.alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean(), any()))
                .thenReturn(UUID.randomUUID());

        dienst.lauf(jetzt);

        // Jede Anlage bekommt ihren EIGENEN Alarm (Multi-Alert, §6.4 "Eine Auswahl ergibt je Bezug
        // eine eigene Instanz mit eigener Meldung").
        verify(repo).alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean(), any());
        verify(repo).alarmErzeugen(any(), eq(BEZUG2), any(), any(), any(), anyBoolean(), any());
    }

    @Test
    void eineNeuHinzugekommeneAnlageWirdSofortMitUeberwacht() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(auswahlRegel("{\"alle\":\"anlage\"}")));
        when(repo.instanz(any(), any())).thenReturn(InstanzZeile.NEU);
        lese(WerteLeser.Lesung.zustand("erreichbar", Instant.now())); // nicht erfüllt - keine Alarme nötig

        when(repo.alleAnlagen()).thenReturn(List.of(ANLAGE));
        dienst.lauf(Instant.now());
        verify(repo).instanz(REGEL, BEZUG);
        verify(repo, never()).instanz(REGEL, BEZUG2);

        // Die Mitgliederliste wird JEDEN Lauf frisch gelesen (§6.4 "sofort mit überwacht") - keine
        // Regeländerung nötig, nur eine neue Anlage im Kundenbereich.
        when(repo.alleAnlagen()).thenReturn(List.of(ANLAGE, ANLAGE2));
        dienst.lauf(Instant.now());
        verify(repo).instanz(REGEL, BEZUG2);
    }

    @Test
    void eineAuswahlAufEinenStandortBeschraenktFragtNurDessenAnlagen() {
        UUID standort = UUID.randomUUID();
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(auswahlRegel("{\"standort\":\"" + standort + "\",\"alle\":\"anlage\"}")));
        when(repo.anlagenDesStandorts(standort)).thenReturn(List.of(ANLAGE));
        when(repo.instanz(any(), any())).thenReturn(InstanzZeile.NEU);
        lese(WerteLeser.Lesung.zustand("erreichbar", Instant.now()));

        dienst.lauf(Instant.now());

        verify(repo).instanz(REGEL, BEZUG);
        verify(repo, never()).alleAnlagen();
    }

    // =================================================================== Scheibe 4: abhängige Meldungen (§6.4 Nr. 7)

    private static UeberwachungZeile deviceRegel() {
        return new UeberwachungZeile(REGEL, null, 1, "PV ohne Leistung", "anlage.pv.leistung",
                json("{\"anlage\":\"" + ANLAGE + "\"}"),
                json("{\"art\":\"ueber\",\"schwelle\":0,\"rueckkehr\":0,\"dauer_s\":0,\"erholen_s\":300}"),
                "warnung", json("[{\"person\":\"sub-jonas\"}]"), "eigen", "system", null, null);
    }

    @Test
    void eineAbhaengigeMeldungWirdErzeugtAberNichtVersendetWennDieBoxNichtMeldet() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(deviceRegel()));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", jetzt, null, null, null, null));
        UUID boxAlarm = UUID.randomUUID();
        when(repo.aktiverAlarmAufAnlage(eq(ANLAGE), any())).thenReturn(java.util.Optional.of(boxAlarm));
        when(anlagenflussLeser.lese(any(), any(), any())).thenReturn(WerteLeser.Lesung.zahl(5.0, "kW", jetzt));
        UUID eigenerAlarm = UUID.randomUUID();
        when(repo.alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean(), eq(boxAlarm)))
                .thenReturn(eigenerAlarm);

        dienst.lauf(jetzt);

        verify(repo).alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean(), eq(boxAlarm));
        verify(ausgang, never()).email(any(), any(), any(), any(), anyInt(), any(), any(), any(), any());
        verify(ausgang, never()).webpush(any(), any(), any(), any(), anyInt(), any(), any(), any(), any(), any());
    }

    @Test
    void eineUnabhaengigeMeldungVersendetGanzNormalOhneAktivenBoxAlarm() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(deviceRegel()));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", jetzt, null, null, null, null));
        when(repo.aktiverAlarmAufAnlage(eq(ANLAGE), any())).thenReturn(java.util.Optional.empty());
        when(anlagenflussLeser.lese(any(), any(), any())).thenReturn(WerteLeser.Lesung.zahl(5.0, "kW", jetzt));
        UUID alarmId = UUID.randomUUID();
        when(repo.alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean(), isNull()))
                .thenReturn(alarmId);

        dienst.lauf(jetzt);

        verify(ausgang).email(eq("alarm"), eq(alarmId), eq("sub-jonas"), eq("ausgeloest"), eq(0), anyString(),
                anyString(), any(), any());
    }

    // =================================================================== Scheibe 4: Drossel (§6.7, nie im Minutentakt)

    private static UeberwachungZeile mengeRegel() {
        return new UeberwachungZeile(REGEL, null, 1, "Verbrauch im Monat", "anlage.verbrauch.menge",
                json("{\"anlage\":\"" + ANLAGE + "\"}"),
                json("{\"art\":\"periode\",\"richtung\":\"ueber\",\"schwelle\":1000,\"periode\":\"monat\","
                        + "\"dauer_s\":0,\"erholen_s\":0}"),
                "hinweis", json("[{\"person\":\"sub-jonas\"}]"), "eigen", "system", null, null);
    }

    @Test
    void einPeriodischerLeserWirdInnerhalbDesMindestabstandsNichtErneutGelesen() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(mengeRegel()));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("normal", null, null, null, null,
                jetzt.minusSeconds(60))); // vor einer Minute gelesen - unter dem 5-Minuten-Mindestabstand

        dienst.lauf(jetzt);

        verify(mengeLeser, never()).lesePeriode(any(), any(), any(), anyBoolean(), any());
    }

    @Test
    void einPeriodischerLeserWirdNachDemMindestabstandErneutGelesen() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(mengeRegel()));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("normal", null, null, null, null,
                jetzt.minusSeconds(600))); // vor 10 Minuten gelesen - über dem 5-Minuten-Mindestabstand
        when(mengeLeser.lesePeriode(any(), any(), any(), anyBoolean(), any())).thenReturn(WerteLeser.Lesung.zahl(
                500, "kWh", jetzt));

        dienst.lauf(jetzt);

        verify(mengeLeser).lesePeriode(any(), any(), eq("monat"), eq(false), any());
    }
}
