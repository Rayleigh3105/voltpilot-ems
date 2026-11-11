package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.voltpilot.api.erzeuger.VorgabenRepository.LueckeZeile;
import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import com.voltpilot.api.web.dto.HistoryEventDto;
import com.voltpilot.api.web.dto.HistoryVorgabenDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Vorgaben einer Erzeugeranlage im Verlauf (UEMS EZ-9, EW-12 A) als reiner Unit-Test - kein Spring, keine DB.
 * Die Fälle folgen dem Büttner-Bild der Konzeptseite: der Netzbetreiber begrenzt zweimal, der Direktvermarkter ruft
 * ab (nicht bindend), Motor 2 ist nicht bereit, in einer Datenlücke zählt der Netzbetreiber drei weitere Wechsel,
 * und eine feste 70-%-Grenze gilt seit Jahren.
 */
class EreignisseVorgabenTest {

    /** Der 21.10.2026 in Berliner Zeit (Sommerzeit, UTC+2). */
    private static final HistoryRange.Window TAG = HistoryRange.DAY.window(LocalDate.parse("2026-10-21"));

    private static Instant utc(String zeit) {
        return Instant.parse("2026-10-21T" + zeit + ":00Z");
    }

    private static final UUID STEUERUNG = UUID.fromString("00000000-0000-0000-0000-00000000e700");

    private static Zeile vorgabe(String urheber, String art, Integer teNr, Instant beginn, Instant ende,
            Instant gesehenBis, String prozent, String w, String energie, Map<String, BigDecimal> jeTag,
            String wert, String bindung, boolean unvollstaendig, List<String> gruende, String einheit) {
        return new Zeile(UUID.nameUUIDFromBytes((urheber + art + teNr + beginn).getBytes()), STEUERUNG, teNr,
                urheber, art, beginn, true, ende, ende != null, gesehenBis,
                prozent == null ? null : new BigDecimal(prozent), w == null ? null : new BigDecimal(w), null, null,
                energie == null ? null : new BigDecimal(energie), energie == null ? null : "pv_prognose", jeTag,
                wert == null ? null : new BigDecimal(wert), "fernwirktechnik", bindung, unvollstaendig, false, 41, 42,
                gruende, Map.of(), Map.of(), einheit);
    }

    // 10:00-11:30 Uhr: der Netzbetreiber begrenzt auf 30 %, die Anlage folgt.
    private static final Zeile NB_30 = vorgabe("netzbetreiber", "p_begrenzung", null, utc("08:00"), utc("09:30"),
            utc("09:30"), "30", null, "51", Map.of("2026-10-21", new BigDecimal("51")), "6.12", "bindend", false,
            List.of(), null);
    // seit 14:32 Uhr: 60 %, läuft, zuletzt gesehen 15:44 Uhr, mit einer Datenlücke.
    private static final Zeile NB_60 = vorgabe("netzbetreiber", "p_begrenzung", null, utc("12:32"), null,
            utc("13:44"), "60", null, "25", Map.of("2026-10-21", new BigDecimal("25")), null, "bindend", true,
            List.of(), null);
    // seit 13:05 Uhr: der Direktvermarkter ruft 80 kW ab - nicht bindend, der Netzbetreiber ist strenger.
    private static final Zeile DV = vorgabe("direktvermarkter", "dv_aktivierung", null, utc("11:05"), null,
            utc("13:44"), null, "80000", "0", Map.of("2026-10-21", BigDecimal.ZERO), null, "nicht_bindend", false,
            List.of(), null);
    // Derselbe Abruf je Motor: nur in der Zählung, nie dreimal in der Chronik.
    private static final Zeile DV_TE1 = vorgabe("direktvermarkter", "dv_aktivierung", 1, utc("11:05"), null,
            utc("13:44"), null, "40000", null, Map.of(), null, null, false, List.of(), "Motor 1");
    // 06:00-07:15 Uhr: Motor 2 ist nicht bereit, der Gasspeicher ist leer.
    private static final Zeile NICHT_BEREIT = vorgabe("anlage", "nicht_bereit", 2, utc("04:00"), utc("05:15"),
            utc("05:15"), null, null, null, Map.of(), null, null, false, List.of("gasspeicher_leer"), "Motor 2");
    // Die Anlage regelt selbst (Automatik): nicht im Verlauf, nur in Chronik und CSV der Vorgaben.
    private static final Zeile AUTOMATIK = vorgabe("anlage", "automatik", null, utc("06:00"), utc("07:00"),
            utc("07:00"), null, null, null, Map.of(), null, "bindend", false, List.of(), null);
    // Die feste 70-%-Grenze gilt seit dem 01.01.2025 und bindet nie.
    private static final Zeile NB_FEST = vorgabe("netzbetreiber", "p_begrenzung", null,
            Instant.parse("2024-12-31T23:00:00Z"), null, utc("13:44"), "70", null, "0", Map.of(), null,
            "nicht_bindend", false, List.of(), null);
    // 03:10-03:24 Uhr: in einer Datenlücke zählt der Netzbetreiber drei weitere Wechsel.
    private static final LueckeZeile LUECKE = new LueckeZeile(UUID.randomUUID(), STEUERUNG, "netzbetreiber",
            utc("01:10"), utc("01:24"), 3, false, 17, 20);

    private static final List<Zeile> ALLE = List.of(NB_FEST, NICHT_BEREIT, AUTOMATIK, NB_30, DV, DV_TE1, NB_60);

    @Test
    void imTagIstJedeVorgabeEinEreignisMitIhrerVorgabeUndDerLueckeOhneErfundeneZeit() {
        List<HistoryEventDto> events = Ereignisse.vorgaben(HistoryRange.DAY, TAG, ALLE, List.of(LUECKE));

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::start, HistoryEventDto::end,
                HistoryEventDto::count, HistoryEventDto::minutes).containsExactly(
                        tuple("netzbetreiber", TAG.from(), utc("13:44"), 1, 944L),
                        tuple("netzbetreiber", utc("01:10"), utc("01:24"), 0, 14L),
                        tuple("nicht-bereit", utc("04:00"), utc("05:15"), 1, 75L),
                        tuple("netzbetreiber", utc("08:00"), utc("09:30"), 1, 90L),
                        tuple("direktvermarkter", utc("11:05"), utc("13:44"), 1, 159L),
                        tuple("netzbetreiber", utc("12:32"), utc("13:44"), 1, 72L));
        assertThat(events).extracting(HistoryEventDto::text).containsExactly(
                "Netzbetreiber begrenzt auf 70 % (nicht bindend)",
                "Netzbetreiber: 3 weitere Wechsel während einer Datenlücke",
                "Motor 2 nicht bereit für den Direktvermarkter: Gasspeicher leer",
                "Netzbetreiber begrenzt auf 30 %, geschätzt 51,0 kWh nicht erzeugt",
                "Direktvermarkter ruft 80,0 kW ab (nicht bindend)",
                "Netzbetreiber begrenzt auf 60 %, geschätzt 25,0 kWh nicht erzeugt - unvollständig");

        // Die feste Grenze: auf den Tag geschnitten, ihr wirklicher Beginn steht an der Vorgabe.
        HistoryEventDto.Vorgabe fest = events.get(0).vorgabe();
        assertThat(fest.beginn()).isEqualTo(NB_FEST.beginn());
        assertThat(fest.laeuft()).isTrue();
        assertThat(fest.id()).isEqualTo(NB_FEST.id());
        assertThat(events.get(0).value()).isEqualByComparingTo("0");

        // Die Lücke ist keine Vorgabe: ohne id, ohne Zahl, mit ihren weiteren Wechseln.
        HistoryEventDto luecke = events.get(1);
        assertThat(luecke.value()).isNull();
        assertThat(luecke.vorgabe().id()).isNull();
        assertThat(luecke.vorgabe().luecken()).isEqualTo(1);
        assertThat(luecke.vorgabe().weitereWechsel()).isEqualTo(3);

        HistoryEventDto nichtBereit = events.get(2);
        assertThat(nichtBereit.value()).as("ohne Grundlage keine Energie, nie 0").isNull();
        assertThat(nichtBereit.unit()).isNull();
        assertThat(nichtBereit.vorgabe().gruende()).containsExactly("Gasspeicher leer");
        assertThat(nichtBereit.vorgabe().teNr()).isEqualTo(2);
        assertThat(nichtBereit.vorgabe().einheitName()).isEqualTo("Motor 2");

        HistoryEventDto nb30 = events.get(3);
        assertThat(nb30.value()).isEqualByComparingTo("51");
        assertThat(nb30.unit()).isEqualTo("kWh");
        assertThat(nb30.vorgabe().wertEur()).isEqualByComparingTo("6.12");
        assertThat(nb30.vorgabe().bindung()).isEqualTo("bindend");
        assertThat(nb30.vorgabe().laeuft()).isFalse();
        assertThat(nb30.vorgabe().ende()).isEqualTo(utc("09:30"));
        assertThat(nb30.vorgabe().vorgabeProzent()).isEqualByComparingTo("30");

        HistoryEventDto dv = events.get(4);
        assertThat(dv.vorgabe().vorgabeW()).isEqualByComparingTo("80000");
        assertThat(dv.vorgabe().art()).isEqualTo("dv_aktivierung");
        assertThat(dv.planned()).isFalse();

        assertThat(events.get(5).vorgabe().unvollstaendig()).isEqualTo(1);
        assertThat(events.get(5).vorgabe().wertEur()).as("ohne Preisgrundlage leer").isNull();
    }

    @Test
    void nachArtZaehltDenGanzenTagJeUrheberVereinigtUndJeEinheit() {
        HistoryVorgabenDto z = Ereignisse.vorgabenZaehlung(HistoryRange.DAY, TAG, ALLE, List.of(LUECKE),
                utc("13:45"));

        assertThat(z.verarbeitetBis()).isEqualTo(utc("13:45"));
        assertThat(z.zaehlung()).extracting(HistoryVorgabenDto.Zaehlung::periode,
                HistoryVorgabenDto.Zaehlung::type, HistoryVorgabenDto.Zaehlung::teNr,
                HistoryVorgabenDto.Zaehlung::einheitName, HistoryVorgabenDto.Zaehlung::anzahl,
                HistoryVorgabenDto.Zaehlung::minutes).containsExactly(
                        // Die feste Grenze deckt den Tag bis 15:44 Uhr: vereinigt 944 Minuten, nicht 944 + 90 + 72.
                        tuple(null, "netzbetreiber", null, null, 3, 944L),
                        tuple(null, "direktvermarkter", null, null, 1, 159L),
                        tuple(null, "direktvermarkter", 1, "Motor 1", 1, 159L),
                        tuple(null, "nicht-bereit", null, null, 1, 75L),
                        tuple(null, "nicht-bereit", 2, "Motor 2", 1, 75L));
        HistoryVorgabenDto.Zaehlung nb = z.zaehlung().get(0);
        assertThat(nb.energyKwh()).isEqualByComparingTo("76");
        assertThat(nb.wertEur()).isEqualByComparingTo("6.12");
        assertThat(nb.unvollstaendig()).isEqualTo(1);
        assertThat(nb.arten()).containsExactlyEntriesOf(Map.of("p_begrenzung", 3));
        assertThat(nb.luecken()).isEqualTo(1);
        assertThat(nb.weitereWechsel()).isEqualTo(3);
        assertThat(z.zaehlung().get(3).energyKwh()).as("„nicht bereit“ hat keine Energie").isNull();
        assertThat(z.zaehlung().get(3).ohneSchaetzung()).isEqualTo(1);
    }

    /** Eine Vorgabe von 22:00 bis 02:00 Uhr über Mitternacht in den 21.10. */
    private static final Zeile UEBER_MITTERNACHT = vorgabe("netzbetreiber", "abschaltung", null,
            Instant.parse("2026-10-20T20:00:00Z"), Instant.parse("2026-10-21T00:00:00Z"),
            Instant.parse("2026-10-21T00:00:00Z"), "0", null, "12",
            Map.of("2026-10-20", new BigDecimal("4"), "2026-10-21", new BigDecimal("8")), null, "bindend", false,
            List.of(), null);

    @Test
    void imMonatBuendeltJederTagSeineVorgabenUndNachArtZaehltSieEinmal() {
        HistoryRange.Window monat = HistoryRange.MONTH.window(LocalDate.parse("2026-10-21"));
        List<HistoryEventDto> events = Ereignisse.vorgaben(HistoryRange.MONTH, monat,
                List.of(UEBER_MITTERNACHT, NB_30), List.of(LUECKE));

        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::start, HistoryEventDto::end,
                HistoryEventDto::count, HistoryEventDto::minutes, HistoryEventDto::days).containsExactly(
                        tuple("netzbetreiber", Instant.parse("2026-10-20T20:00:00Z"),
                                Instant.parse("2026-10-20T22:00:00Z"), 1, 120L, 1),
                        tuple("netzbetreiber", Instant.parse("2026-10-20T22:00:00Z"), utc("09:30"), 2, 210L, 1));
        assertThat(events.get(0).value()).isEqualByComparingTo("4");
        assertThat(events.get(1).value()).isEqualByComparingTo("59");
        assertThat(events.get(1).text()).isEqualTo("Netzbetreiber: 2×, zusammen 3 Std 30 Min; "
                + "geschätzt 59,0 kWh nicht erzeugt; 3 weitere Wechsel während einer Datenlücke");
        assertThat(events.get(1).vorgabe().id()).as("ein Bündel öffnet seinen Tag, keine Vorgabe").isNull();
        assertThat(events.get(1).vorgabe().luecken()).isEqualTo(1);
        assertThat(events.get(1).vorgabe().weitereWechsel()).isEqualTo(3);

        HistoryVorgabenDto z = Ereignisse.vorgabenZaehlung(HistoryRange.MONTH, monat,
                List.of(UEBER_MITTERNACHT, NB_30), List.of(), null);
        assertThat(z.zaehlung()).singleElement().satisfies(nb -> {
            assertThat(nb.anzahl()).as("über Mitternacht einmal gezählt").isEqualTo(2);
            assertThat(nb.minutes()).isEqualTo(330L);
            assertThat(nb.energyKwh()).isEqualByComparingTo("63");
            assertThat(nb.arten()).containsExactlyInAnyOrderEntriesOf(Map.of("abschaltung", 1, "p_begrenzung", 1));
        });
    }

    @Test
    void imJahrBuendeltJederMonatUndNachArtNenntJedenMonat() {
        HistoryRange.Window jahr = HistoryRange.YEAR.window(LocalDate.parse("2026-10-21"));
        Zeile maerz = vorgabe("direktvermarkter", "dv_stopp", null, Instant.parse("2026-03-10T09:00:00Z"),
                Instant.parse("2026-03-10T10:00:00Z"), Instant.parse("2026-03-10T10:00:00Z"), null, null, null,
                Map.of(), null, "bindend", false, List.of(), null);
        List<Zeile> zeilen = List.of(maerz, UEBER_MITTERNACHT, NB_30);

        List<HistoryEventDto> events = Ereignisse.vorgaben(HistoryRange.YEAR, jahr, zeilen, List.of());
        assertThat(events).extracting(HistoryEventDto::type, HistoryEventDto::count, HistoryEventDto::days)
                .containsExactly(tuple("direktvermarkter", 1, 1), tuple("netzbetreiber", 2, 2));
        assertThat(events.get(0).text()).isEqualTo("Direktvermarkter: 1 Std");

        HistoryVorgabenDto z = Ereignisse.vorgabenZaehlung(HistoryRange.YEAR, jahr, zeilen, List.of(), null);
        assertThat(z.zaehlung()).extracting(HistoryVorgabenDto.Zaehlung::periode,
                HistoryVorgabenDto.Zaehlung::type, HistoryVorgabenDto.Zaehlung::anzahl).containsExactly(
                        tuple(null, "netzbetreiber", 2), tuple(null, "direktvermarkter", 1),
                        tuple("2026-03", "direktvermarkter", 1), tuple("2026-10", "netzbetreiber", 2));
    }

    @Test
    void ohneVorgabenGibtEsKeineEreignisseUndEineLeereZaehlung() {
        assertThat(Ereignisse.vorgaben(HistoryRange.DAY, TAG, List.of(AUTOMATIK), List.of())).isEmpty();
        assertThat(Ereignisse.vorgabenZaehlung(HistoryRange.WEEK,
                HistoryRange.WEEK.window(LocalDate.parse("2026-10-21")), List.of(), List.of(), null).zaehlung())
                .isEmpty();
    }

    @Test
    void eineLueckeNachEinemNeustartNenntKeineZahl() {
        LueckeZeile neustart = new LueckeZeile(UUID.randomUUID(), STEUERUNG, "direktvermarkter", utc("01:10"),
                utc("01:24"), null, true, 17, 2);
        HistoryEventDto e = Ereignisse.vorgaben(HistoryRange.DAY, TAG, List.of(), List.of(neustart)).get(0);
        assertThat(e.type()).isEqualTo("direktvermarkter");
        assertThat(e.vorgabe().weitereWechsel()).as("unbekannt, nie 0").isNull();
        assertThat(e.text()).isEqualTo("Direktvermarkter: weitere Wechsel während einer Datenlücke "
                + "(Zahl unbekannt, die Steuerung startete neu)");
    }
}
