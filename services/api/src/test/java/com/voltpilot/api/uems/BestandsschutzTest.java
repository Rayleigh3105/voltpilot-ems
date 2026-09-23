package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Der Vergleich von {@link Bestandsschutz} ohne Datenbank: was er durchlässt und was er fängt. */
class BestandsschutzTest {

    private static final Map<String, String> VORHER = Map.of(
            "measurement_point", "a1", "schedule", "b2", "messstelle_formel_term", Bestandsschutz.LEER);

    private static Map<String, String> nachher(String... paare) {
        Map<String, String> aus = new LinkedHashMap<>(VORHER);
        for (int i = 0; i < paare.length; i += 2) {
            if (paare[i + 1] == null) {
                aus.remove(paare[i]);
            } else {
                aus.put(paare[i], paare[i + 1]);
            }
        }
        return aus;
    }

    @Test
    void gleicherBestandIstKeineAbweichung() {
        assertThat(Bestandsschutz.abweichungen(VORHER, nachher())).isEmpty();
    }

    @Test
    void eineSpaeterHinzugekommeneLeereTabelleIstKeineAbweichung() {
        assertThat(Bestandsschutz.abweichungen(VORHER,
                nachher("messstelle_formel_fassung", Bestandsschutz.LEER))).isEmpty();
    }

    @Test
    void eineSpaeterHinzugekommeneTabelleMitInhaltIstEine() {
        assertThat(Bestandsschutz.abweichungen(VORHER, nachher("messstelle_formel_fassung", "c3")))
                .containsExactly("messstelle_formel_fassung: neue Tabelle mit Inhalt");
    }

    @Test
    void eineGeaenderteBestandstabelleIstEine() {
        assertThat(Bestandsschutz.abweichungen(VORHER, nachher("measurement_point", "a9")))
                .containsExactly("measurement_point: bestehender Inhalt geändert");
    }

    @Test
    void eineLeereBestandstabelleDieInhaltBekommtIstEine() {
        assertThat(Bestandsschutz.abweichungen(VORHER, nachher("messstelle_formel_term", "d4")))
                .containsExactly("messstelle_formel_term: bestehender Inhalt geändert");
    }

    /** Ein neuer Laufzeitstand hängt seine Katalog-Metadaten an; ein bestehender Stand bleibt gemessen. */
    @Test
    void einAngehaengterLaufzeitstandIstKeineAbweichungEinGeaenderterSchon() {
        Map<String, String> vorher = new LinkedHashMap<>(VORHER);
        vorher.put("measurement_catalog_point_metadata@2026.08.26.3", "e5");
        Map<String, String> angehaengt = new LinkedHashMap<>(vorher);
        angehaengt.put("measurement_catalog_point_metadata@2026.09.23.2", "f6");
        assertThat(Bestandsschutz.abweichungen(vorher, angehaengt)).isEmpty();
        angehaengt.put("measurement_catalog_point_metadata@2026.08.26.3", "e9");
        assertThat(Bestandsschutz.abweichungen(vorher, angehaengt))
                .containsExactly("measurement_catalog_point_metadata@2026.08.26.3: bestehender Inhalt geändert");
    }

    @Test
    void eineVerschwundeneBestandstabelleIstEine() {
        assertThat(Bestandsschutz.abweichungen(VORHER, nachher("schedule", null)))
                .containsExactly("schedule: bestehende Tabelle fehlt");
    }
}
