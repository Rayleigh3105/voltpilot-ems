package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Rechte der Berichts-Routen (UEMS AP-12 IP-7, E12 G1–G3) — rein, gegen die Matrix-Datei und die Familie
 * {@code rechte} von {@code bericht-vectors.json}.
 *
 * <ul>
 *   <li>{@link BerichtRechte#MATRIX} ist Zelle für Zelle die Matrix-Datei (acht Berichts-Zeilen und
 *       {@code messwerte.ansehen} für die Teilansicht).</li>
 *   <li>AP-19 IP-11 (RE4, W10, NW-5): Lesen und Freigeben sind am Unternehmen und an der energetischen Bewertung getrennt —
 *       und jede Bestandsrolle darf danach an jeder Handlung genau, was sie vorher durfte (Vorher-Nachher-Tabelle).</li>
 *   <li>B13: ALLE dreizehn Zeilen und die Teilansicht je Person gehen durch {@link BerichtRechte} — dieselbe Stelle, die
 *       die Routen fragen. Die vier Export-Zeilen haben ihre Route erst mit IP-10; ihr Urteil steht hier schon fest.</li>
 *   <li>Der heutige Plattform-Admin (VoltPilot-Unterstützung) bekommt an keiner Handlung eines Berichts ein Ja.</li>
 * </ul>
 */
class BerichtRechteTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> HANDLUNGEN = List.of(BerichtRechte.ABRUFEN, BerichtRechte.ANLEGEN,
            BerichtRechte.FREIGEBEN, BerichtRechte.VERWERFEN, BerichtRechte.ARCHIVIEREN);

    @Test
    void dieNeunZeilenSindZelleFuerZelleDieDerMatrixDatei() throws Exception {
        Matrix datei = RechteAbleitung.matrix(JSON.readTree(V2.resolve("rechte-matrix.json").toFile()));
        assertThat(BerichtRechte.MATRIX.aktionen().keySet()).containsExactlyInAnyOrder(BerichtRechte.STANDORT_ABRUFEN,
                BerichtRechte.STANDORT_FREIGEBEN, BerichtRechte.UNTERNEHMEN, BerichtRechte.UNTERNEHMEN_ABRUFEN,
                BerichtRechte.BEWERTUNG, BerichtRechte.BEWERTUNG_ANSEHEN, BerichtRechte.EXPORT_STANDORT,
                BerichtRechte.EXPORT_UNTERNEHMEN, BerichtRechte.ANSEHEN);
        for (String kennung : BerichtRechte.MATRIX.aktionen().keySet()) {
            assertThat(BerichtRechte.MATRIX.aktion(kennung)).as(kennung).isEqualTo(datei.aktion(kennung));
        }
        assertThat(BerichtRegeln.RECHTE).allMatch(k -> BerichtRechte.MATRIX.aktionen().containsKey(k));
    }

    /**
     * G1 — die Handlungen der Routen dieses Pakets tragen die Kennung aus {@link BerichtRegeln#kennung}; seit AP-19 IP-11
     * lesen Abrufen und PDF am Unternehmen und an der energetischen Bewertung über ihre eigene Kennung (RE4, W10).
     */
    @Test
    void jedeHandlungDerRoutenHatIhreKennung() {
        Map<String, String> erwartet = new LinkedHashMap<>();
        erwartet.put("standort/abrufen", BerichtRechte.STANDORT_ABRUFEN);
        erwartet.put("standort/pdf", BerichtRechte.STANDORT_ABRUFEN);
        erwartet.put("standort/anlegen", BerichtRechte.STANDORT_FREIGEBEN);
        erwartet.put("standort/freigeben", BerichtRechte.STANDORT_FREIGEBEN);
        erwartet.put("standort/verwerfen", BerichtRechte.STANDORT_FREIGEBEN);
        erwartet.put("standort/archivieren", BerichtRechte.STANDORT_FREIGEBEN);
        erwartet.put("unternehmen/abrufen", BerichtRechte.UNTERNEHMEN_ABRUFEN);
        erwartet.put("unternehmen/pdf", BerichtRechte.UNTERNEHMEN_ABRUFEN);
        erwartet.put("unternehmen/csv", BerichtRechte.EXPORT_UNTERNEHMEN);
        for (String h : List.of(BerichtRechte.ANLEGEN, BerichtRechte.FREIGEBEN, BerichtRechte.VERWERFEN,
                BerichtRechte.ARCHIVIEREN, BerichtRechte.WIEDERVORLAGE_AENDERN)) {
            erwartet.put("unternehmen/" + h, BerichtRechte.UNTERNEHMEN);
        }
        erwartet.forEach((schluessel, kennung) -> {
            String[] teile = schluessel.split("/");
            assertThat(BerichtRegeln.kennung(teile[1], teile[0])).as(schluessel).isEqualTo(kennung);
        });
        for (String handlung : BerichtRegeln.HANDLUNGEN) {
            boolean lesen = BerichtRechte.ABRUFEN.equals(handlung) || BerichtRechte.PDF.equals(handlung);
            assertThat(BerichtRechte.kennung(handlung, BerichtRegeln.UNTERNEHMEN, BerichtRegeln.ENERGETISCHE_BEWERTUNG))
                    .as(handlung).isEqualTo(lesen ? BerichtRechte.BEWERTUNG_ANSEHEN : BerichtRechte.BEWERTUNG);
        }
    }

    /**
     * NW-5 (AP-19 IP-11, RE4): jede Bestandsrolle darf nach der Trennung genau, was sie vorher durfte. „Vorher“ ist die
     * Kennung, die jede Handlung bis AP-19 IP-11 trug ({@link #vorher}); „nachher“ ist {@link BerichtRechte#kennung}.
     * Verglichen wird das ganze Urteil (ja/403/404, Rolle, nötige Rolle, Text) gegen die Matrix-Datei — je Rolle, Handlung,
     * Geltung, Standort und Vorlage. Der Test druckt die Tabelle; {@code *} markiert die Zeilen mit neuer Kennung.
     */
    @Test
    void jedeBestandsrolleDarfNachDerTrennungGenauWasSieVorherDurfte() throws Exception {
        Matrix datei = RechteAbleitung.matrix(JSON.readTree(V2.resolve("rechte-matrix.json").toFile()));
        Instant jetzt = Instant.parse("2026-11-25T09:00:00Z");
        Kundenbereich kb = new Kundenbereich("Kunststoffwerk Ahrenberg GmbH",
                List.of(new Standort("ST-1", "Werk Ahrenberg"), new Standort("ST-2", "Werk Lindach")),
                List.of(new Person("JW", "Jonas Wendlinger")));
        Map<String, Benutzer> rollen = bestandsrollen();
        List<String> abweichungen = new ArrayList<>();
        List<String> tabelle = new ArrayList<>();
        int neu = 0;
        record Fall(String geltung, String standort, String vorlage) {}
        List<Fall> faelle = List.of(new Fall(BerichtRegeln.STANDORT, "ST-1", BerichtRegeln.MONATSBERICHT_STANDORT),
                new Fall(BerichtRegeln.STANDORT, "ST-2", BerichtRegeln.MONATSBERICHT_STANDORT),
                new Fall(BerichtRegeln.UNTERNEHMEN, null, BerichtRegeln.MONATSBERICHT_UNTERNEHMEN),
                new Fall(BerichtRegeln.UNTERNEHMEN, null, BerichtRegeln.ENERGETISCHE_BEWERTUNG));
        for (Fall f : faelle) {
            RechteAbleitung.Ziel ziel = f.standort() == null ? RechteAbleitung.Ziel.unternehmen()
                    : RechteAbleitung.Ziel.standort(f.standort());
            for (String h : BerichtRegeln.HANDLUNGEN) {
                String alt = vorher(h, f.geltung(), f.vorlage());
                String jetztKennung = BerichtRechte.kennung(h, f.geltung(), f.vorlage());
                StringBuilder zeile = new StringBuilder();
                for (Map.Entry<String, Benutzer> r : rollen.entrySet()) {
                    DarfErgebnis a = RechteAbleitung.darf(datei, r.getValue(), kb, alt, ziel, jetzt);
                    DarfErgebnis n = RechteAbleitung.darf(datei, r.getValue(), kb, jetztKennung, ziel, jetzt);
                    if (!a.equals(n)) {
                        abweichungen.add(r.getKey() + " " + f + " " + h + ": vorher " + a + ", nachher " + n);
                    }
                    zeile.append(String.format(" %-5s", a.darf() ? "ja" : String.valueOf(a.http())));
                }
                boolean anders = !alt.equals(jetztKennung);
                neu += anders ? 1 : 0;
                tabelle.add(String.format("%s%s", zeile, String.format("  %s %-33s %-26s %-11s %s", anders ? "*" : " ",
                        f.geltung() + "/" + h, f.vorlage(), f.standort() == null ? "Unternehmen" : f.standort(),
                        anders ? alt + " → " + jetztKennung : alt)));
            }
        }
        System.out.println("NW-5 vorher = nachher je Bestandsrolle (Urteil vorher; nachher gleich, sonst rot):");
        System.out.println(String.format("%s", rollen.keySet().stream().map(k -> String.format(" %-5s", k))
                .reduce("", String::concat)) + "    Handlung                          Vorlage                    Ziel        Kennung");
        tabelle.forEach(System.out::println);
        assertThat(abweichungen).as("Bestandsrollen mit anderem Urteil nach der Trennung").isEmpty();
        // Die Trennung ist wirklich geschehen: Abrufen und PDF am Unternehmen und an der Bewertung — sonst nichts.
        assertThat(neu).isEqualTo(4);
    }

    /** Die Kennung jeder Handlung bis AP-19 IP-11 — die Tabelle von damals, als Orakel des Vorher-Nachher-Vergleichs. */
    private static String vorher(String handlung, String geltungArt, String vorlage) {
        if (BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(vorlage)) {
            return BerichtRechte.BEWERTUNG;
        }
        boolean standort = BerichtRegeln.STANDORT.equals(geltungArt);
        return BerichtRechte.CSV.equals(handlung) ? (standort ? BerichtRechte.EXPORT_STANDORT : BerichtRechte.EXPORT_UNTERNEHMEN)
                : !standort ? BerichtRechte.UNTERNEHMEN
                : BerichtRechte.ABRUFEN.equals(handlung) || BerichtRechte.PDF.equals(handlung) ? BerichtRechte.STANDORT_ABRUFEN
                : BerichtRechte.STANDORT_FREIGEBEN;
    }

    /** Die sieben Bestandsrollen (der Unterstützer in allen drei Umfängen), Standort-Rollen an Werk Ahrenberg (ST-1). */
    private static Map<String, Benutzer> bestandsrollen() {
        Instant ab = Instant.parse("2026-01-01T00:00:00Z");
        Map<String, Benutzer> r = new LinkedHashMap<>();
        r.put("KA", person(Konto.BENUTZER, new Zuweisung(Rolle.KUNDENADMINISTRATOR, null, null, null, ab, null, null)));
        r.put("EM", person(Konto.BENUTZER, new Zuweisung(Rolle.ENERGIEMANAGER, null, null, null, ab, null, null)));
        r.put("BE", person(Konto.BENUTZER, new Zuweisung(Rolle.BEARBEITER, List.of("ST-1"), null, null, ab, null, null)));
        r.put("BD", person(Konto.BENUTZER,
                new Zuweisung(Rolle.BEDIENBERECHTIGT, List.of("ST-1"), null, null, ab, null, null)));
        r.put("LE", person(Konto.BENUTZER, new Zuweisung(Rolle.LESER, List.of("ST-1"), null, null, ab, null, null)));
        Map<Umfang, String> umfang = Map.of(Umfang.ANSEHEN, "US-A", Umfang.EINRICHTEN, "US-Ei",
                Umfang.EINRICHTEN_UND_BEDIENEN, "US-B");
        for (Umfang u : Umfang.values()) {
            r.put(umfang.get(u), person(Konto.PARTNER,
                    new Zuweisung(Rolle.UNTERSTUETZER, List.of("ST-1"), u, Art.INSTALLATEUR, ab, null, null)));
        }
        r.put("VB", person(Konto.PLATTFORM, new Zuweisung(Rolle.VOLTPILOT_BETRIEB, null, null, null, ab, null, null)));
        return r;
    }

    private static Benutzer person(Konto konto, Zuweisung z) {
        return new Benutzer("P", "Person", konto, KontoZustand.AKTIV, List.of(z));
    }

    /** B13 — die dreizehn Zeilen der Matrix und die Teilansicht je Person, durch die Stelle der Routen. */
    @Test
    void b13AlleDreizehnZeilenUndDieTeilansichtGehenDurchBerichtRechte() throws Exception {
        JsonNode pruefung = null;
        for (JsonNode c : JSON.readTree(V2.resolve("bericht-vectors.json").toFile()).path("cases")) {
            for (JsonNode p : c.path("pruefungen")) {
                if ("rechte".equals(p.path("regel").asText())) {
                    pruefung = p;
                }
            }
        }
        assertThat(pruefung).as("Prüfung rechte in bericht-vectors.json").isNotNull();
        JsonNode e = pruefung.path("eingang");
        Instant jetzt = OffsetDateTime.parse(e.path("jetzt").asText()).toInstant();
        List<Standort> standorte = new ArrayList<>();
        e.path("kundenbereich").path("standorte").forEach(s -> standorte.add(new Standort(s.path("kennzeichen").asText(),
                s.path("name").asText())));
        List<Person> admins = new ArrayList<>();
        e.path("kundenbereich").path("kundenadministratoren").forEach(p -> admins.add(new Person(p.path("kennung").asText(),
                p.path("name").asText())));
        Kundenbereich kb = new Kundenbereich(e.path("kundenbereich").path("name").asText(), standorte, admins);
        Map<String, Benutzer> personen = personen(e.path("personen"));

        List<JsonNode> soll = new ArrayList<>();
        pruefung.path("ergebnis").path("ergebnisse").forEach(soll::add);
        assertThat(soll).hasSize(13);
        int i = 0;
        for (JsonNode a : e.path("anfragen")) {
            String standort = a.path("standort").isNull() ? null : a.path("standort").asText();
            DarfErgebnis d = BerichtRechte.darf(personen.get(a.path("person").asText()), kb, a.path("handlung").asText(),
                    a.path("geltung_art").asText(), standort, jetzt);
            JsonNode s = soll.get(i++);
            assertThat(BerichtRegeln.kennung(a.path("handlung").asText(), a.path("geltung_art").asText()))
                    .isEqualTo(s.path("kennung").asText());
            assertThat(d.darf() ? "ja" : String.valueOf(d.http())).as(a.toString()).isEqualTo(s.path("ergebnis").asText());
        }
        assertThat(i).isEqualTo(13);

        JsonNode teil = pruefung.path("ergebnis").path("teilansicht");
        personen.forEach((kennung, b) -> {
            List<String> t = BerichtRechte.teilansicht(b, kb, jetzt);
            assertThat(t == null ? null : String.join(", ", t)).as(kennung)
                    .isEqualTo(teil.path(kennung).isNull() ? null : teil.path(kennung).asText());
        });
    }

    /** Der Plattform-Admin von heute ist VoltPilot-Unterstützung (AP-03 E8): nie ein Entwurf, nie ein Stand, nie ein Anlegen. */
    @Test
    void derUnterstuetzerBekommtAnKeinerHandlungEinJa() {
        Benutzer voss = KorrekturRechte.benutzer(ProtokollAkteur.fuer("kc-lena-voss", "Lena Voss", true));
        Kundenbereich kb = new Kundenbereich("Kundenbereich", List.of(new Standort("st-1", "Werk Ahrenberg")), List.of());
        Instant jetzt = Instant.parse("2026-11-25T09:00:00Z");
        for (String h : HANDLUNGEN) {
            assertThat(BerichtRechte.darf(voss, kb, h, BerichtRegeln.STANDORT, "st-1", jetzt).http()).as(h).isEqualTo(403);
            assertThat(BerichtRechte.darf(voss, kb, h, BerichtRegeln.UNTERNEHMEN, null, jetzt).http()).as(h).isEqualTo(403);
        }
        Benutzer kunde = KorrekturRechte.benutzer(ProtokollAkteur.fuer("kc-jonas", "Jonas Wendlinger", false));
        for (String h : HANDLUNGEN) {
            assertThat(BerichtRechte.darf(kunde, kb, h, BerichtRegeln.STANDORT, "st-1", jetzt).darf()).as(h).isTrue();
        }
    }

    static Map<String, Benutzer> personen(JsonNode liste) {
        Map<String, Benutzer> personen = new LinkedHashMap<>();
        for (JsonNode p : liste) {
            List<Zuweisung> zuweisungen = new ArrayList<>();
            for (JsonNode z : p.path("zuweisungen")) {
                List<String> st = null;
                if (!z.path("standorte").isNull()) {
                    st = new ArrayList<>();
                    for (JsonNode s : z.path("standorte")) {
                        st.add(s.asText());
                    }
                }
                zuweisungen.add(new Zuweisung(Rolle.vonCode(z.path("rolle").asText()), st,
                        z.path("umfang").isNull() ? null : Umfang.vonCode(z.path("umfang").asText()),
                        z.path("art").isNull() ? null : Art.vonCode(z.path("art").asText()),
                        OffsetDateTime.parse(z.path("gueltig_ab").asText()).toInstant(),
                        z.path("gueltig_bis").isNull() ? null : z.path("gueltig_bis").asText(), null));
            }
            personen.put(p.path("kennung").asText(), new Benutzer(p.path("kennung").asText(), p.path("name").asText(),
                    Konto.vonCode(p.path("konto").asText()), KontoZustand.vonCode(p.path("zustand").asText()), zuweisungen));
        }
        return personen;
    }
}
