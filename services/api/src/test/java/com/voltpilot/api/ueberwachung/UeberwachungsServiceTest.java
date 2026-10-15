package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
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
    private final ZugriffRepository zugriffe = mock(ZugriffRepository.class);
    private final PriceRepository preise = mock(PriceRepository.class);
    private final WerteKatalog katalog = new WerteKatalog();
    private final BenachrichtigungAusgang ausgang = mock(BenachrichtigungAusgang.class);
    private final UeberwachungsService dienst = new UeberwachungsService(repo, katalog, leser, ereignisLeser,
            anlagenflussLeser, messreiheLeser, zugriffe, preise);

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

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean());
        // Schon "normal" und weiterhin unerfüllt (unbekannt zählt nie als erfüllt): kein Schreiben nötig.
        verify(repo, never()).instanzSpeichern(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void einRueckfallVorAblaufDerDauerLoestKeinenAlarmAus() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant seit = Instant.now().minusSeconds(100); // unter den 900 s Dauer
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", seit, null, null, null));
        lese(WerteLeser.Lesung.zustand("erreichbar", Instant.now())); // nicht mehr erfüllt

        dienst.lauf(Instant.now());

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("normal"), eq(null), any(), any(), any(), any());
    }

    @Test
    void ausstehendWirdErstNachAblaufDerDauerZuEinemAlarm() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("warnung")));
        Instant jetzt = Instant.now();
        Instant seit = jetzt.minusSeconds(901); // über die 900 s Dauer
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", seit, null, null, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt));
        UUID alarmId = UUID.randomUUID();
        when(repo.alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean())).thenReturn(alarmId);
        when(repo.alarm(alarmId)).thenReturn(java.util.Optional.empty());

        dienst.lauf(jetzt);

        verify(repo).alarmErzeugen(any(), eq(BEZUG), any(), any(), any(), anyBoolean());
        verify(ausgang).email(eq("alarm"), eq(alarmId), eq("sub-jonas"), eq("ausgeloest"), anyString(), anyString());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("aktiv"), eq(jetzt), any(), any(), eq(alarmId), any());
    }

    @Test
    void einHinweisAlarmVersendetKeineEmail() {
        nichtsGesaet();
        when(repo.aktive()).thenReturn(List.of(regel("hinweis")));
        Instant jetzt = Instant.now();
        when(repo.instanz(REGEL, BEZUG)).thenReturn(new InstanzZeile("ausstehend", jetzt.minusSeconds(901), null,
                null, null));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt));
        when(repo.alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean())).thenReturn(UUID.randomUUID());

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
                offenerAlarm));
        lese(WerteLeser.Lesung.zustand("nicht_erreichbar", jetzt)); // wieder erfüllt - Rückfall

        dienst.lauf(jetzt);

        verify(repo, never()).alarmErzeugen(any(), any(), any(), any(), any(), anyBoolean());
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
                offenerAlarm));
        lese(WerteLeser.Lesung.zustand("erreichbar", jetzt)); // nicht mehr erfüllt

        dienst.lauf(jetzt);

        verify(repo).alarmWiederNormal(offenerAlarm, jetzt, true);
        verify(repo, never()).gesehen(any(), any(), any());
        verify(repo).instanzSpeichern(eq(REGEL), eq(BEZUG), eq("normal"), eq(null), any(), any(), eq(null), any());
    }
}
