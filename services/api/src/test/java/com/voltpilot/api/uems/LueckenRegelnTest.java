package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln des Lücken-Melders (UEMS AP-07 IP-9) — ohne Datenbank. Der Kern: die Schwelle
 * ist die des Zustandsvertrags, nicht eine zweite Zahl, und die Lücke ist eine andere Aussage als
 * „liefert Daten“.
 */
class LueckenRegelnTest {

    private static final Path ZUSTAND_VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2",
            "uems-zustand-vectors.json");

    private static Instant t(String s) {
        return Instant.parse(s);
    }

    /** Der Faktor steht im Vertrag — und die Regeln lesen genau diese Konstante. */
    @Test
    void dieSchwelleIstDieDesZustandsvertrags() throws Exception {
        JsonNode toleranz = new ObjectMapper().readTree(ZUSTAND_VEKTOREN.toFile()).path("toleranz");
        assertThat(toleranz.path("luecke_faktor").asInt()).isEqualTo(ZustandAbleitung.LUECKE_FAKTOR);
        assertThat(LueckenRegeln.HERZSCHLAG_TOLERANZ_S)
                .as("max(2 × 15 s, Boden der Toleranz) — AP-06: 14:00 still, 14:05 erkannt")
                .isEqualTo(toleranz.path("mindestens_s").asLong());
    }

    /** An der Kante von 2 × Kadenz: genau 2 × Kadenz ist noch keine Lücke, eine Sekunde mehr ist eine. */
    @Test
    void dieKanteGehoertNochNichtZurLuecke() {
        Instant letzter = t("2026-11-04T23:45:00Z");
        assertThat(LueckenRegeln.reiheOffen(letzter, 900, t("2026-11-05T00:15:00Z"))).isFalse();
        assertThat(LueckenRegeln.reiheOffen(letzter, 900, t("2026-11-05T00:15:01Z"))).isTrue();
        assertThat(LueckenRegeln.reiheFaelligAb(letzter, 900)).isEqualTo(t("2026-11-05T00:15:01Z"));
        // Dieselbe Minute bei der Kadenz von VORHER (60 s) wäre längst eine Lücke — darum zählt die
        // Kadenz zum Zeitpunkt.
        assertThat(LueckenRegeln.reiheOffen(letzter, 60, t("2026-11-05T00:15:00Z"))).isTrue();
    }

    /** Ohne Boden und ohne Deckel: eine Reihe liefert Daten UND hat eine offene Lücke. */
    @Test
    void liefertDatenUndLueckeSindZweiAussagen() {
        Instant letzter = t("2026-11-04T23:45:00Z");
        Instant jetzt = t("2026-11-05T00:15:01Z");
        ZustandAbleitung.LiefertDatenErgebnis beobachtung = ZustandAbleitung.liefertDaten(
                new ZustandAbleitung.LiefertDatenEingang(true, letzter, false, 900, jetzt,
                        ZustandAbleitung.VORGABE_ZEITZONE));
        assertThat(beobachtung.zustand()).isEqualTo(ZustandAbleitung.LiefertDaten.LIEFERT);
        assertThat(LueckenRegeln.reiheOffen(letzter, 900, jetzt)).isTrue();
        // Und umgekehrt: bei 60 s Kadenz ist nach 190 s die Lücke offen, die Beobachtung „liefert“
        // (der Boden von 300 s) — der Fall, den man falsch erwartet.
        assertThat(LueckenRegeln.reiheOffen(letzter, 60, letzter.plusSeconds(190))).isTrue();
        assertThat(ZustandAbleitung.liefertDaten(new ZustandAbleitung.LiefertDatenEingang(true, letzter,
                false, 60, letzter.plusSeconds(190), ZustandAbleitung.VORGABE_ZEITZONE)).zustand())
                .isEqualTo(ZustandAbleitung.LiefertDaten.LIEFERT);
        // Ein Tageszähler: nach 30 h liefert er keine Daten mehr (Deckel 86 400 s), hat aber noch
        // keine Lücke (2 × 86 400 s).
        assertThat(LueckenRegeln.reiheOffen(letzter, 86_400, letzter.plusSeconds(30 * 3600))).isFalse();
    }

    @Test
    void dieLueckeBeginntBeimErstenFehlendenWertUndZaehltJeKadenz() {
        // MS-06: letzter Wert 10:39, Lücke ab 10:40, erster Wert danach 10:47 → 7 fehlende Werte.
        Instant von = LueckenRegeln.lueckeBeginn(t("2026-11-18T09:39:00Z"), 60);
        assertThat(von).isEqualTo(t("2026-11-18T09:40:00Z"));
        assertThat(LueckenRegeln.erwartetFehlend(von, t("2026-11-18T09:47:00Z"), 60)).isEqualTo(7);
        // A3: 14:00–17:30 bei 60 s.
        assertThat(LueckenRegeln.erwartetFehlend(t("2026-11-03T13:00:00Z"), t("2026-11-03T16:30:00Z"), 60))
                .isEqualTo(210);
        assertThat(LueckenRegeln.erwartetFehlend(von, von, 60)).isZero();
    }

    @Test
    void dieBoxSchweigtStriktNachDerToleranz() {
        Instant letzter = t("2026-11-03T13:00:00Z");
        assertThat(LueckenRegeln.boxSchweigt(letzter, t("2026-11-03T13:05:00Z"))).isFalse();
        assertThat(LueckenRegeln.boxSchweigt(letzter, t("2026-11-03T13:05:01Z"))).isTrue();
        assertThat(LueckenRegeln.boxFaelligAb(letzter)).isEqualTo(t("2026-11-03T13:05:01Z"));
    }

    @Test
    void zeitenAufDieSekundeUndNieEinLeererZeitraum() {
        assertThat(LueckenRegeln.sekunde(t("2026-11-03T13:00:00.900Z"))).isEqualTo(t("2026-11-03T13:00:00Z"));
        assertThat(LueckenRegeln.sekundeAuf(t("2026-11-03T13:00:00.100Z"))).isEqualTo(t("2026-11-03T13:00:01Z"));
        assertThat(LueckenRegeln.sekundeAuf(t("2026-11-03T13:00:00Z"))).isEqualTo(t("2026-11-03T13:00:00Z"));
        assertThat(LueckenRegeln.lueckeEnde(t("2026-11-03T13:00:00.200Z"), t("2026-11-03T13:00:00.700Z")))
                .isEqualTo(t("2026-11-03T13:00:01Z"));
        assertThat(LueckenRegeln.lueckeEnde(t("2026-11-03T13:00:00Z"), t("2026-11-03T16:30:00.5Z")))
                .isEqualTo(t("2026-11-03T16:30:00Z"));
    }

    /** Dieselbe Lücke → dieselbe Kennung; ein anderes {@code von} → ein anderes Ereignis. */
    @Test
    void dieKennungenSindAbgeleitet() {
        UUID kb = UUID.randomUUID();
        UUID box = UUID.randomUUID();
        UUID dq = UUID.randomUUID();
        Instant von = t("2026-11-03T13:00:00Z");
        assertThat(LueckenRegeln.boxKennung(kb, box, von)).isEqualTo(LueckenRegeln.boxKennung(kb, box, von));
        assertThat(LueckenRegeln.boxKennung(kb, box, von.plusMillis(400)))
                .as("auf die Sekunde, wie die Meldung").isEqualTo(LueckenRegeln.boxKennung(kb, box, von));
        assertThat(LueckenRegeln.boxKennung(kb, box, von.plusSeconds(1)))
                .isNotEqualTo(LueckenRegeln.boxKennung(kb, box, von));
        assertThat(LueckenRegeln.quelleKennung(kb, box, dq, von))
                .isNotEqualTo(LueckenRegeln.boxKennung(kb, box, von));
        assertThat(LueckenRegeln.boxKennung(UUID.randomUUID(), box, von))
                .as("Mandant gehört zur Kennung").isNotEqualTo(LueckenRegeln.boxKennung(kb, box, von));
    }
}
