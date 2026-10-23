package com.voltpilot.api.orte;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Adresssuche beim Anlegen (Anlage-Flow a1, D4 = A): Länderfilter, Reihenfolge, Doppel,
 * Merken und Fehlerpfade - gegen einen gespielten Photon, nie gegen den echten Dienst.
 * Befund F3: „10115“ fand New York, „Weißenburg“ zuerst das Elsass, eine Hausadresse nichts.
 */
class OrteSucheTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Photon-Antwort (GeoJSON) mit Treffern innerhalb und außerhalb von DE/AT/CH. */
    private static final String ANTWORT = """
            {"type":"FeatureCollection","features":[
             {"geometry":{"coordinates":[-74.0,40.7]},"properties":{"countrycode":"US","type":"city","name":"New York City","postcode":"10115"}},
             {"geometry":{"coordinates":[7.94,49.04]},"properties":{"countrycode":"FR","type":"city","name":"Wissembourg"}},
             {"geometry":{"coordinates":[10.7166,49.1147]},"properties":{"countrycode":"DE","type":"city","name":"Gunzenhausen","postcode":"91710"}},
             {"geometry":{"coordinates":[10.7131,49.1162]},"properties":{"countrycode":"DE","type":"street","name":"Hauptstraße","postcode":"91710","city":"Gunzenhausen"}},
             {"geometry":{"coordinates":[10.7155,49.1159]},"properties":{"countrycode":"DE","type":"house","street":"Hauptstraße","housenumber":"12","postcode":"91710","city":"Gunzenhausen"}},
             {"geometry":{"coordinates":[10.7155,49.1159]},"properties":{"countrycode":"DE","type":"house","street":"Hauptstraße","housenumber":"12","postcode":"91710","city":"Gunzenhausen"}},
             {"geometry":{"coordinates":[16.37,48.21]},"properties":{"countrycode":"AT","type":"city","name":"Wien","postcode":"1010"}},
             {"geometry":{"coordinates":[8.54,47.37]},"properties":{"countrycode":"CH","type":"house","street":"Bahnhofstrasse","housenumber":"1","postcode":"8001","city":"Zürich"}}
            ]}""";

    private final List<URI> abrufe = new ArrayList<>();
    private Instant jetzt = Instant.parse("2026-10-23T08:00:00Z");

    private OrteSuche suche(OrteSuche.Abruf abruf) {
        Clock uhr = new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneId.of("UTC");
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return jetzt;
            }
        };
        return new OrteSuche(URI.create("http://photon.test/api"), abruf, JSON, uhr);
    }

    private OrteSuche.Abruf antwortet(int status, String koerper) {
        return uri -> {
            abrufe.add(uri);
            return new OrteSuche.Ergebnis(status, koerper);
        };
    }

    @Test
    void nurDeutschlandOesterreichSchweizHaeuserZuerstOhneDoppel() {
        OrteSuche.Antwort a = suche(antwortet(200, ANTWORT)).suchen("Hauptstr 12 gun");
        assertThat(a.quelle()).isEqualTo("© OpenStreetMap-Mitwirkende");
        assertThat(a.treffer()).extracting(OrteSuche.Treffer::text).containsExactly(
                "Hauptstraße 12, 91710 Gunzenhausen",
                "Bahnhofstrasse 1, 8001 Zürich",
                "Hauptstraße, 91710 Gunzenhausen",
                "91710 Gunzenhausen",
                "1010 Wien, Österreich");
        OrteSuche.Treffer haus = a.treffer().get(0);
        assertThat(haus.genau()).isEqualTo("haus");
        assertThat(haus.strasse()).isEqualTo("Hauptstraße");
        assertThat(haus.hausnummer()).isEqualTo("12");
        assertThat(haus.plz()).isEqualTo("91710");
        assertThat(haus.ort()).isEqualTo("Gunzenhausen");
        assertThat(haus.land()).isEqualTo("DE");
        assertThat(haus.breitengrad()).isEqualTo(49.1159);
        assertThat(haus.laengengrad()).isEqualTo(10.7155);
        assertThat(a.treffer()).extracting(OrteSuche.Treffer::land).doesNotContain("US", "FR");

        URI uri = abrufe.get(0);
        assertThat(uri.getQuery()).contains("q=Hauptstr 12 gun").contains("lang=de").contains("bbox=5.86,45.81,17.17,55.06");
    }

    /** Photon nennt eine Postleitzahl als Ort ({@code osm_value: postcode}) - gezeigt wird sie mit ihrem Ort. */
    @Test
    void postleitzahlHeisstWieIhrOrt() {
        OrteSuche.Antwort a = suche(antwortet(200, """
                {"features":[{"geometry":{"coordinates":[13.38,52.53]},"properties":{"countrycode":"DE","type":"other",
                "osm_key":"place","osm_value":"postcode","name":"10115","city":"Berlin"}}]}""")).suchen("10115");
        assertThat(a.treffer()).extracting(OrteSuche.Treffer::text).containsExactly("10115 Berlin");
        assertThat(a.treffer().get(0).plz()).isEqualTo("10115");
        assertThat(a.treffer().get(0).ort()).isEqualTo("Berlin");
    }

    @Test
    void gleicheAnfrageWirdGemerktBisSieAblaeuft() {
        OrteSuche s = suche(antwortet(200, ANTWORT));
        s.suchen("Hauptstraße 12, Gunzenhausen");
        s.suchen("  hauptstraße 12,   GUNZENHAUSEN ");
        assertThat(abrufe).hasSize(1);
        jetzt = jetzt.plus(Duration.ofHours(25));
        s.suchen("Hauptstraße 12, Gunzenhausen");
        assertThat(abrufe).hasSize(2);
    }

    @Test
    void unterDreiZeichenGehtNichtsHinaus() {
        OrteSuche s = suche(antwortet(200, ANTWORT));
        assertThat(s.suchen("Ha").treffer()).isEmpty();
        assertThat(s.suchen(null).treffer()).isEmpty();
        assertThat(abrufe).isEmpty();
        assertThatThrownBy(() -> s.suchen("x".repeat(201))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void dienstFehltOderAntwortetFalsch() {
        assertThatThrownBy(() -> suche(antwortet(503, "")).suchen("Gunzenhausen"))
                .isInstanceOf(OrteSuche.NichtErreichbar.class);
        assertThatThrownBy(() -> suche(antwortet(200, "<html>")).suchen("Gunzenhausen"))
                .isInstanceOf(OrteSuche.NichtErreichbar.class);
        assertThatThrownBy(() -> suche(uri -> {
            throw new IOException("connect timed out");
        }).suchen("Gunzenhausen")).isInstanceOf(OrteSuche.NichtErreichbar.class);
        // Ein Fehler wird nicht gemerkt: die nächste Anfrage fragt wieder.
        OrteSuche s = suche(antwortet(503, ""));
        assertThatThrownBy(() -> s.suchen("Gunzenhausen")).isInstanceOf(OrteSuche.NichtErreichbar.class);
        assertThatThrownBy(() -> s.suchen("Gunzenhausen")).isInstanceOf(OrteSuche.NichtErreichbar.class);
        assertThat(abrufe).hasSize(4);
    }

    @Test
    void controllerAntwortet503MitDemWeg() {
        OrteSucheController c = new OrteSucheController(suche(antwortet(503, "")));
        var r = c.nichtErreichbar(new OrteSuche.NichtErreichbar("x", null));
        assertThat(r.getStatusCode().value()).isEqualTo(503);
        assertThat(r.getBody()).containsEntry("code", "adresssuche_nicht_erreichbar");
        assertThat(r.getBody().get("message")).contains("Punkt auf der Karte selbst setzen");
    }
}
