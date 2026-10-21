package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.ArgumentMatchers.notNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Fassung;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Jungster;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Steuerung;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.InstanzZeile;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.UeberwachungZeile;
import com.voltpilot.api.uems.GeraetRepository.Teil;
import com.voltpilot.api.versand.BenachrichtigungAusgang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Die Erzeuger-Vorlagen (UEMS EZ-11) als Wertefolgen durch den ECHTEN Zustandsautomaten der Überwachung: auslösen
 * erst nach der Dauer, keine zweite Meldung solange der Alarm steht, veraltete Werte halten ihn statt zu entwarnen,
 * Entwarnung nach der Erholdauer, Versand auf allen vier Wegen ({@code quelle = alarm}, damit der Zusteller die
 * Ruhezeiten anwendet) - und je Einheit eine eigene, gebündelte Meldung. Ohne Datenbank: die Instanzen leben in einer
 * Map, das Bild der Steuerung in {@link #bild}. Die Auswertung selbst prüft {@link ErzeugerAlarmeTest}.
 */
class ErzeugerUeberwachungTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID REGEL = UUID.randomUUID();
    private static final UUID ANLAGE = UUID.randomUUID();
    private static final UUID GERAET = UUID.randomUUID();
    private static final UUID KOMPONENTE = UUID.randomUUID();
    private static final Instant T0 = Instant.parse("2026-10-21T12:00:00Z");

    private final UeberwachungRepository repo = mock(UeberwachungRepository.class);
    private final AnlagensteuerungRepository steuerungen = mock(AnlagensteuerungRepository.class);
    private final BenachrichtigungAusgang ausgang = mock(BenachrichtigungAusgang.class);
    private final UeberwachungsService dienst = new UeberwachungsService(repo, new WerteKatalog(),
            mock(ZustandWerteLeser.class), mock(EreignisWerteLeser.class), mock(AnlagenflussWerteLeser.class),
            mock(MessreiheWerteLeser.class), mock(MengeWerteLeser.class), mock(GeldWerteLeser.class),
            mock(KennzahlWerteLeser.class), mock(ZaehlungWerteLeser.class), mock(ZugriffRepository.class),
            mock(PriceRepository.class), mock(com.voltpilot.api.repo.PeakShavingRepository.class),
            mock(com.voltpilot.api.uems.MessstelleRepository.class), mock(com.voltpilot.api.uems.KennzahlService.class),
            mock(com.voltpilot.api.uems.EnergiezielService.class));

    /** Das Bild der Steuerung: Punktschlüssel → Rohwert. Jeder Wert ist 5 s vor dem Takt gemessen, außer die Box liefert nicht. */
    private final Map<String, Long> bild = new HashMap<>();
    private Instant takt = T0;
    /** Ab diesem Zeitpunkt kommen keine neuen Werte mehr (Lücke); {@code null} = die Box liefert. */
    private Instant liefertBis;
    private final Map<String, InstanzZeile> instanzen = new HashMap<>();
    private final List<UUID> alarme = new ArrayList<>();
    private final Map<UUID, AlarmZeile> alarmZeilen = new HashMap<>();

    ErzeugerUeberwachungTest() {
        dienst.setAusgang(ausgang);
        dienst.setErzeugerLeser(new ErzeugerWerteLeser(steuerungen));
        when(repo.anlageName(ANLAGE)).thenReturn("Gore");
        when(repo.aktiverAlarmAufAnlage(any(), any())).thenReturn(Optional.empty());
        when(repo.instanz(eq(REGEL), anyString()))
                .thenAnswer(a -> instanzen.getOrDefault(a.<String>getArgument(1), InstanzZeile.NEU));
        doAnswer(a -> {
            instanzen.put(a.getArgument(1), new InstanzZeile(a.getArgument(2), a.getArgument(3), null,
                    a.getArgument(5), a.getArgument(6), a.getArgument(7)));
            return null;
        }).when(repo).instanzSpeichern(eq(REGEL), anyString(), anyString(), any(), any(), any(), any(), any());
        when(repo.alarmErzeugen(any(), anyString(), any(), any(), any(), anyBoolean(), any())).thenAnswer(a -> {
            UUID id = UUID.randomUUID();
            alarme.add(id);
            alarmZeilen.put(id, new AlarmZeile(id, "A-2026-" + alarme.size(), REGEL, null, a.getArgument(1),
                    "erzeuger", "warnung", takt, "aktiv", null, null, null, null, false, 0, null, null));
            return id;
        });
        when(repo.alarm(any())).thenAnswer(a -> Optional.ofNullable(alarmZeilen.get(a.<UUID>getArgument(0))));

        Steuerung s = new Steuerung(GERAET, ANLAGE, "G-1", "G-1", "PFC200", "WAGO", "750-8212", T0.minusSeconds(86400),
                KOMPONENTE, UUID.randomUUID(), "Q-1", "10.0.0.5:502", 1);
        when(steuerungen.steuerungen(ANLAGE)).thenReturn(List.of(s));
        when(steuerungen.steuerung(GERAET)).thenReturn(Optional.of(s));
        when(steuerungen.fassung(GERAET)).thenReturn(Optional.of(new Fassung(UUID.randomUUID(), "erzeuger", 0, 4,
                "big", 2, "bhkw", 1L, "[]", 120, null, T0.minusSeconds(86400))));
        when(steuerungen.einheiten(GERAET)).thenReturn(List.of(einheit(1, "Motor 1"), einheit(2, "Motor 2")));
        when(steuerungen.juengste(any(), eq(KOMPONENTE), any())).thenAnswer(a -> {
            List<String> keys = a.getArgument(2);
            Instant gemessen = (liefertBis == null ? takt : liefertBis).minusSeconds(5);
            return keys.stream().map(k -> bild.containsKey(k)
                    ? new Jungster(k, gemessen, BigDecimal.valueOf(bild.get(k)), "good")
                    : new Jungster(k, null, null, null)).toList();
        });
    }

    private static Teil einheit(int teNr, String name) {
        return new Teil(UUID.randomUUID(), GERAET, Teil.ERZEUGUNGSEINHEIT, null, name, null, null,
                T0.minusSeconds(86400), null, teNr, "bhkw_motor", BigDecimal.valueOf(500), null, null);
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void regel(String wertart, String bedingung) {
        when(repo.aktive()).thenReturn(List.of(new UeberwachungZeile(REGEL, null, 1, null, wertart,
                json("{\"anlage\":\"" + ANLAGE + "\"}"), json(bedingung), "warnung", json("[{\"person\":\"sub-mo\"}]"),
                "eigen", "sub-mo", null, null)));
    }

    /** Die Regel, wie das Anlegen sie aus der Vorlage vorbelegt (Katalog `vorlage`). */
    private void vorlage(String wertart) {
        WerteKatalog.Eintrag e = new WerteKatalog().eintrag(wertart);
        regel(wertart, UeberwachungAnlegenService.vorlageAnwenden(e,
                (com.fasterxml.jackson.databind.node.ObjectNode) json("{\"art\":\"zustand\"}")).toString());
    }

    private void lauf(long sekundenSeitT0) {
        takt = T0.plusSeconds(sekundenSeitT0);
        dienst.lauf(takt);
    }

    private void folgtNicht() {
        bild.put("erzeuger.wirkung.quelle_p", 1L);
        bild.put("erzeuger.wirkung.p_grenze_w", 600_000L);
        bild.put("erzeuger.a.p_erzeugung_w", 700_000L);
        bild.put("erzeuger.a.p_installiert_kw", 1000L);
    }

    private void verifyVersand(String anlass, int mal) {
        verify(ausgang, times(mal)).email(eq("alarm"), any(), eq("sub-mo"), eq(anlass), eq(0), anyString(),
                anyString(), any(), eq("warnung"), any());
        verify(ausgang, times(mal)).webpush(eq("alarm"), any(), eq("sub-mo"), eq(anlass), eq(0), anyString(),
                anyString(), any(), eq("warnung"), any());
        verify(ausgang, times(mal)).webhook(eq("alarm"), any(), eq("sub-mo"), eq(anlass), eq(0), anyString(),
                anyString(), any(), eq("warnung"), any());
        verify(ausgang, times(mal)).telegram(eq("alarm"), any(), eq("sub-mo"), eq(anlass), eq(0), anyString(),
                anyString(), any(), eq("warnung"), any());
    }

    @Test
    void anlageFolgtNichtLoestNachDerDauerEinmalAusHaeltBeiVeraltetenWertenUndEntwarntNachDerErholdauer() {
        vorlage("erzeuger.anlage_folgt_nicht");
        folgtNicht();

        lauf(0); // normal → ausstehend
        lauf(285); // Dauer (300 s) läuft noch
        assertThat(alarme).isEmpty();
        lauf(300); // ausgelöst
        assertThat(alarme).hasSize(1);
        verifyVersand("ausgeloest", 1);
        ArgumentCaptor<String> betreff = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> inhalt = ArgumentCaptor.forClass(String.class);
        verify(ausgang).email(eq("alarm"), any(), any(), eq("ausgeloest"), anyInt(), betreff.capture(),
                inhalt.capture(), any(), any(), isNull());
        assertThat(betreff.getValue()).isEqualTo("Warnung: Anlage folgt nicht");
        assertThat(inhalt.getValue()).startsWith("Anlage Gore: Die Anlage erzeugt 100,0 kW mehr als die wirksame "
                + "Grenze erlaubt").endsWith("Kennzeichen A-2026-1.");

        lauf(600); // weiter erfüllt: keine zweite Meldung
        liefertBis = takt; // die Box liefert nicht mehr: die Werte veralten
        lauf(900);
        lauf(1500);
        assertThat(instanzen.get("anlage:" + ANLAGE).zustand()).isEqualTo("aktiv"); // Unbekannt entwarnt nicht
        verify(repo, never()).alarmWiederNormal(any(), any(), anyBoolean());

        liefertBis = null;
        bild.put("erzeuger.a.p_erzeugung_w", 590_000L); // folgt wieder
        lauf(1515); // aktiv → erholend
        lauf(1700); // Erholdauer (300 s) läuft noch
        verify(repo, never()).alarmWiederNormal(any(), any(), anyBoolean());
        lauf(1815);
        verify(repo).alarmWiederNormal(alarme.get(0), T0.plusSeconds(1815), true);
        verifyVersand("ausgeloest", 1);
        verifyVersand("wieder_normal", 1);
        verify(ausgang).email(eq("alarm"), any(), any(), eq("wieder_normal"), anyInt(), betreff.capture(),
                inhalt.capture(), any(), any(), isNull());
        assertThat(betreff.getValue()).isEqualTo("Wieder normal: Anlage folgt nicht");
        assertThat(inhalt.getValue()).startsWith("Anlage Gore: Die Anlage hält die wirksame Grenze ein.")
                .endsWith("Wieder normal seit 21.10.2026 14:30 Uhr.");
        assertThat(alarme).hasSize(1);
    }

    @Test
    void einRueckfallVorDerDauerLoestNichtsAus() {
        vorlage("erzeuger.anlage_folgt_nicht");
        folgtNicht();
        lauf(0);
        lauf(200);
        bild.put("erzeuger.a.p_erzeugung_w", 600_000L);
        lauf(215); // ausstehend → normal
        folgtNicht();
        lauf(230); // beginnt von vorn
        lauf(500);
        assertThat(alarme).isEmpty();
        lauf(530);
        assertThat(alarme).hasSize(1);
    }

    @Test
    void fernsteuerungNichtBereitMeldetJeEinheitGebuendeltMitGrund() {
        vorlage("erzeuger.fernsteuerung_nicht_bereit");
        bild.put("erzeuger.dv.d_kanal", 1L);
        bild.put("erzeuger.te[1].t_bits", 0b0111L); // bereit
        bild.put("erzeuger.te[2].t_bits", 0b0011L | (1L << 7)); // nicht bereit, Wartung

        lauf(0);
        lauf(300);

        assertThat(alarme).hasSize(1);
        verify(repo).alarmErzeugen(any(), eq("einheit:" + GERAET + ";te=2"), any(), any(), any(), anyBoolean(),
                any());
        verify(repo, never()).alarmErzeugen(any(), eq("einheit:" + GERAET + ";te=1"), any(), any(), any(),
                anyBoolean(), any());
        ArgumentCaptor<String> inhalt = ArgumentCaptor.forClass(String.class);
        // je Einheit = eine Auswahl: mit Bündel-Schlüssel, damit mehrere Einheiten in EINER Nachricht ankommen
        verify(ausgang).email(eq("alarm"), any(), any(), eq("ausgeloest"), anyInt(), anyString(), inhalt.capture(),
                any(), any(), notNull());
        assertThat(inhalt.getValue()).startsWith(
                "Anlage Gore: Motor 2 ist nicht bereit für den Direktvermarkter. Grund: Wartung.");
    }

    @Test
    void ohneDirektvermarkterKanalMeldetFernsteuerungNichts() {
        vorlage("erzeuger.fernsteuerung_nicht_bereit");
        bild.put("erzeuger.dv.d_kanal", 0L);
        bild.put("erzeuger.te[1].t_bits", 0L);
        bild.put("erzeuger.te[2].t_bits", 0L);
        lauf(0);
        lauf(900);
        assertThat(alarme).isEmpty();
    }

    @Test
    void netzbetreiberAbschaltungMeldetImNaechstenTakt() {
        vorlage("erzeuger.netzbetreiber_abgeschaltet");
        bild.put("erzeuger.wirkung.quelle_p", 1L);
        bild.put("erzeuger.nb.n_bits", 0b1011L); // Not-Aus des Netzbetreibers
        lauf(0);
        lauf(15);
        assertThat(alarme).hasSize(1);
        verifyVersand("ausgeloest", 1);
    }

    @Test
    void fernwirkVerbindungWegErstNachZehnMinutenUndNurBeiFernwirktechnik() {
        vorlage("erzeuger.fernwirk_verbindung_weg");
        bild.put("erzeuger.nb.n_kanal", 3L);
        bild.put("erzeuger.nb.n_bits", 0b0001L);
        lauf(0);
        lauf(585);
        assertThat(alarme).isEmpty();
        lauf(600);
        assertThat(alarme).hasSize(1);
    }

    @Test
    void datenVeraltetMeldetEineLueckeNachDerDauer() {
        vorlage("erzeuger.daten_veraltet");
        bild.put("erzeuger.a.a_gueltig", 8L);
        bild.put("erzeuger.nb.n_kanal", 3L);
        bild.put("erzeuger.dv.d_kanal", 1L);
        bild.put("erzeuger.wirkung.quelle_p", 0L);
        bild.put("erzeuger.te[1].t_art", 2L);
        bild.put("erzeuger.te[2].t_art", 2L);
        lauf(0);
        assertThat(instanzen.get("anlage:" + ANLAGE)).isNull(); // aktuell: nichts zu speichern
        liefertBis = takt;
        lauf(60); // noch innerhalb der 120 s
        lauf(130); // veraltet → ausstehend
        lauf(420);
        assertThat(alarme).isEmpty();
        lauf(430);
        assertThat(alarme).hasSize(1);
        verifyVersand("ausgeloest", 1);
    }

    @Test
    void ohneAnlagensteuerungRuhtDieVorlage() {
        vorlage("erzeuger.anlage_folgt_nicht");
        when(steuerungen.steuerungen(ANLAGE)).thenReturn(List.of());
        folgtNicht();
        lauf(0);
        lauf(900);
        assertThat(alarme).isEmpty();
        assertThat(instanzen).isEmpty();
    }
}
