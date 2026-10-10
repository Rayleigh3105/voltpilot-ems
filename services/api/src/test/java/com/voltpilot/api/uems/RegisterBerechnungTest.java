package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.MessstelleRegisterRepository.Messwert;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Werte;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die Berechnung im Register, gesehen von einem Leser mit Zaun (AP-03 R-A3/R-A6/R-A7): ein Messkanal an einer
 * Komponente außerhalb des Zugriffs zählt wie eine Messstelle außerhalb — er fehlt in {@code fehlend} und im Text, und
 * sein Zustand geht nicht ins Urteil ein. Das Urteil darf sich darum zwischen „fremder Kanal liefert“ und „liefert
 * nicht“ nicht unterscheiden, sonst verriete es seinen Zustand.
 */
class RegisterBerechnungTest {

    private static final Instant JETZT = Instant.parse("2026-09-21T10:00:00Z");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final String HINWEIS = RechtPruefung.AUSSERHALB_ZUGRIFF;

    private static final UUID HIER = UUID.randomUUID();
    private static final UUID DORT = UUID.randomUUID();
    private static final Messwert HIER_KANAL = kanal(HIER, "sunspec.model_203.totwhimp");
    private static final Messwert DORT_KANAL = kanal(DORT, "sunspec.model_203.totwhexp");
    private static final Messwert HIER_ZWEITER = kanal(HIER, "sunspec.model_203.w");

    @Test
    void einFremderKanalFehltImUrteilUndVerraetSeinenZustandNicht() {
        UUID ms32 = UUID.randomUUID();
        RegisterBerechnung.Plan plan = plan(Map.of(ms32, List.of(eingang(HIER_KANAL), eingang(DORT_KANAL))));

        // Der sichtbare Kanal liefert nicht: „unvollständig“ mit genau ihm, der fremde nie genannt.
        List<MessstelleDto.RegisterBerechnung> urteile = new ArrayList<>();
        for (Map<Messwert, Werte> dort : List.of(liefert(DORT_KANAL), liefertNicht(DORT_KANAL), Map.<Messwert, Werte>of())) {
            Map<Messwert, Werte> werte = new HashMap<>(dort);
            werte.putAll(liefertNicht(HIER_KANAL));
            urteile.add(gezaeunt(plan, werte).get(ms32));
        }
        MessstelleDto.RegisterBerechnung b = urteile.get(0);
        assertThat(b.zustand()).isEqualTo(RegisterBerechnung.UNVOLLSTAENDIG);
        assertThat(b.fehlend()).containsExactly(HIER_KANAL.kanal());
        assertThat(b.text()).endsWith(" · " + HINWEIS).doesNotContain(DORT_KANAL.kanal());
        assertThat(urteile).allSatisfy(u -> assertThat(u).isEqualTo(b));

        // Alle sichtbaren liefern: nicht zu fällen — nie „vollständig“, gleich, was der fremde tut.
        urteile.clear();
        for (Map<Messwert, Werte> dort : List.of(liefert(DORT_KANAL), liefertNicht(DORT_KANAL), Map.<Messwert, Werte>of())) {
            Map<Messwert, Werte> werte = new HashMap<>(dort);
            werte.putAll(liefert(HIER_KANAL));
            urteile.add(gezaeunt(plan, werte).get(ms32));
        }
        assertThat(urteile).allSatisfy(u -> assertThat(u).isEqualTo(new MessstelleDto.RegisterBerechnung(
                RegisterBerechnung.AUSSERHALB_ZUGRIFF, List.of(), null, HINWEIS)));
    }

    @Test
    void auchUeberEineBerechneteMessstelleHinweg() {
        UUID innen = UUID.randomUUID();
        UUID aussen = UUID.randomUUID();
        RegisterBerechnung.Plan plan = plan(Map.of(
                innen, List.of(eingang(DORT_KANAL), eingang(HIER_ZWEITER)),
                aussen, List.of(new RegisterBerechnung.Eingang("MS-40", innen, null), eingang(HIER_KANAL))));

        for (boolean zweiterLiefert : List.of(true, false)) {
            List<Map<UUID, MessstelleDto.RegisterBerechnung>> urteile = new ArrayList<>();
            for (Map<Messwert, Werte> dort : List.of(liefert(DORT_KANAL), liefertNicht(DORT_KANAL))) {
                Map<Messwert, Werte> werte = new HashMap<>(dort);
                werte.putAll(liefert(HIER_KANAL));
                werte.putAll(zweiterLiefert ? liefert(HIER_ZWEITER) : liefertNicht(HIER_ZWEITER));
                urteile.add(gezaeunt(plan, werte));
            }
            assertThat(urteile.get(0)).as("zweiter liefert: " + zweiterLiefert).isEqualTo(urteile.get(1));
            assertThat(urteile.get(0).values()).allSatisfy(u -> {
                assertThat(u.zustand()).isNotEqualTo(RegisterBerechnung.VOLLSTAENDIG);
                assertThat(u.fehlend()).doesNotContain(DORT_KANAL.kanal());
                assertThat(u.text()).contains(HINWEIS).doesNotContain(DORT_KANAL.kanal());
            });
            if (zweiterLiefert) {
                assertThat(urteile.get(0).get(aussen).zustand()).isEqualTo(RegisterBerechnung.AUSSERHALB_ZUGRIFF);
            } else {
                assertThat(urteile.get(0).get(innen).fehlend()).containsExactly(HIER_ZWEITER.kanal());
                assertThat(urteile.get(0).get(aussen).fehlend()).containsExactly("MS-40");
            }
        }
    }

    @Test
    void ohneZaunRechnenInterneLeserMitAllenEingaengen() {
        UUID ms32 = UUID.randomUUID();
        RegisterBerechnung.Plan plan = plan(Map.of(ms32, List.of(eingang(HIER_KANAL), eingang(DORT_KANAL))));
        Map<Messwert, Werte> werte = new HashMap<>(liefert(HIER_KANAL));
        werte.putAll(liefert(DORT_KANAL));
        assertThat(ungezaeunt(plan, werte).get(ms32).zustand()).isEqualTo(RegisterBerechnung.VOLLSTAENDIG);
        assertThat(sieht(plan, werte, k -> true).get(ms32)).isEqualTo(ungezaeunt(plan, werte).get(ms32));

        werte.putAll(liefertNicht(DORT_KANAL));
        MessstelleDto.RegisterBerechnung b = ungezaeunt(plan, werte).get(ms32);
        assertThat(b.zustand()).isEqualTo(RegisterBerechnung.UNVOLLSTAENDIG);
        assertThat(b.fehlend()).containsExactly(DORT_KANAL.kanal());
        assertThat(b.text()).doesNotContain(HINWEIS);
    }

    @Test
    void jedeKomponenteWirdHoechstensEinmalGefragt() {
        RegisterBerechnung.Plan plan = plan(Map.of(
                UUID.randomUUID(), List.of(eingang(DORT_KANAL), eingang(HIER_KANAL)),
                UUID.randomUUID(), List.of(eingang(DORT_KANAL), eingang(HIER_ZWEITER)),
                UUID.randomUUID(), List.of(new RegisterBerechnung.Eingang("MS-77", null, null))));
        Map<UUID, Integer> gefragt = new HashMap<>();
        Map<UUID, MessstelleDto.RegisterBerechnung> urteile = sieht(plan, Map.of(), k -> {
            gefragt.merge(k, 1, Integer::sum);
            return HIER.equals(k);
        });
        assertThat(gefragt).isEqualTo(Map.of(HIER, 1, DORT, 1));
        assertThat(urteile).hasSize(3);
        // Ein Rest-Term ohne Messstelle im Bestand bleibt, was er war: ein Eingang ohne Datenquelle, kein fremder.
        assertThat(urteile.values()).filteredOn(u -> u.fehlend().contains("MS-77"))
                .singleElement().satisfies(u -> assertThat(u.text()).doesNotContain(HINWEIS));
    }

    // ================================================================ Gerüst

    private static Messwert kanal(UUID komponente, String kanal) {
        return new Messwert(komponente, kanal, RegisterBerechnung.KANAL_SEIT_BEGINN);
    }

    private static RegisterBerechnung.Eingang eingang(Messwert kanal) {
        return new RegisterBerechnung.Eingang(kanal.kanal(), null, kanal);
    }

    private static RegisterBerechnung.Plan plan(Map<UUID, List<RegisterBerechnung.Eingang>> eingaenge) {
        return new RegisterBerechnung.Plan(new LinkedHashMap<>(eingaenge));
    }

    private static Map<Messwert, Werte> liefert(Messwert m) {
        return Map.of(m, new Werte(60, JETZT.minusSeconds(30), 1.0, null, true));
    }

    private static Map<Messwert, Werte> liefertNicht(Messwert m) {
        return Map.of(m, new Werte(60, JETZT.minusSeconds(86_400), 1.0, null, true));
    }

    /** Der Bearbeiter an ST-1: sieht jede Messstelle, von den Komponenten nur {@link #HIER}. */
    private static Map<UUID, MessstelleDto.RegisterBerechnung> gezaeunt(RegisterBerechnung.Plan plan,
            Map<Messwert, Werte> werte) {
        return sieht(plan, werte, HIER::equals);
    }

    private static Map<UUID, MessstelleDto.RegisterBerechnung> sieht(RegisterBerechnung.Plan plan,
            Map<Messwert, Werte> werte, java.util.function.Predicate<UUID> komponente) {
        return RegisterBerechnung.ableiten(plan, Map.of(), werte, m -> 60, JETZT, id -> BERLIN, id -> true, komponente);
    }

    private static Map<UUID, MessstelleDto.RegisterBerechnung> ungezaeunt(RegisterBerechnung.Plan plan,
            Map<Messwert, Werte> werte) {
        return RegisterBerechnung.ableiten(plan, Map.of(), werte, m -> 60, JETZT, id -> BERLIN);
    }
}
