package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die reine Regel „nachts von selbst" (§11.2, S4): Nachtfenster in Sommer- und Winterzeit und an beiden
 * Umstellungen, einer nach dem anderen, kein Drängeln, Halt nach einem Fehlschlag, Obergrenze, Schalter und keine
 * frische Rückmeldung. Dass nur ein Replikat führt, prüft {@code NachtlaufTaktApiTest} mit echter Datenbank.
 */
class NachtlaufTest {

    private static final String ALT = "edge-light-2026.11.5";
    private static final String NEU = "edge-light-2026.11.15";
    private static final String NOCH_NEUER = "edge-light-2026.11.20";

    /** 19.11.2026, 03:00 Berliner Winterzeit (UTC+1). */
    private static final Instant NACHT = Instant.parse("2026-11-19T02:00:00Z");

    private static final FernlaufRegel.Urteil MOEGLICH = new FernlaufRegel.Urteil(true, List.of(),
            new FernlaufRegel.Haken(true, true, true));

    private static Nachtlauf.Box box(String ref, Instant jetzt, Nachtlauf.Lauf... verlauf) {
        return new Nachtlauf.Box(ref, MOEGLICH, NEU, jetzt.minusSeconds(20), List.of(verlauf));
    }

    private static Nachtlauf.Lauf lauf(String ref, String fassung, boolean nachts, String zustand, Instant am) {
        return new Nachtlauf.Lauf(ref, fassung, nachts, zustand, am);
    }

    private static Nachtlauf.Dran dran(Instant jetzt, Nachtlauf.Box b, List<Nachtlauf.Lauf> juengste) {
        return Nachtlauf.plan(true, jetzt, List.of(b), juengste).get(b.edgeRef());
    }

    // ── Nachtfenster ─────────────────────────────────────────────────────

    @Test
    void fensterInDerWinterzeitVonZweiBisFuenfBerlin() {
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-11-19T00:59:59Z"))).isFalse();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-11-19T01:00:00Z"))).isTrue();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-11-19T03:59:59Z"))).isTrue();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-11-19T04:00:00Z"))).isFalse();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-11-19T12:00:00Z"))).isFalse();
    }

    @Test
    void fensterInDerSommerzeitVonZweiBisFuenfBerlin() {
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-07-01T23:59:59Z"))).isFalse();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-07-02T00:00:00Z"))).isTrue();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-07-02T02:59:59Z"))).isTrue();
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-07-02T03:00:00Z"))).isFalse();
    }

    @Test
    void anDenUmstellungenIstDieNachtEineStundeLaengerOderKuerzer() {
        // 25.10.2026: 03:00 Sommerzeit wird 02:00 Winterzeit. Die Nacht beginnt um die erste 02:00 (UTC+2) und
        // endet um 05:00 Winterzeit (UTC+1): vier Stunden.
        Nachtlauf.Nacht herbst = Nachtlauf.nacht(Instant.parse("2026-10-24T12:00:00Z"));
        assertThat(herbst.beginn()).isEqualTo(Instant.parse("2026-10-25T00:00:00Z"));
        assertThat(herbst.ende()).isEqualTo(Instant.parse("2026-10-25T04:00:00Z"));
        assertThat(Nachtlauf.imFenster(Instant.parse("2026-10-25T03:30:00Z"))).isTrue();

        // 28.03.2027: 02:00 Winterzeit wird 03:00 Sommerzeit; 02:00 gibt es nicht, die Nacht beginnt um 03:00
        // Sommerzeit (UTC+2) und endet um 05:00 Sommerzeit: zwei Stunden.
        Nachtlauf.Nacht fruehling = Nachtlauf.nacht(Instant.parse("2027-03-27T12:00:00Z"));
        assertThat(fruehling.beginn()).isEqualTo(Instant.parse("2027-03-28T01:00:00Z"));
        assertThat(fruehling.ende()).isEqualTo(Instant.parse("2027-03-28T03:00:00Z"));
        assertThat(Nachtlauf.imFenster(Instant.parse("2027-03-28T00:30:00Z"))).isFalse();
    }

    @Test
    void nachDemEndeIstDieNaechsteNachtDran() {
        Nachtlauf.Nacht n = Nachtlauf.nacht(Instant.parse("2026-11-19T06:00:00Z"));
        assertThat(n.beginn()).isEqualTo(Instant.parse("2026-11-20T01:00:00Z"));
        // Vor Mitternacht: die Nacht, die nach Mitternacht beginnt (Berliner Tag 20.11.).
        Nachtlauf.Nacht abends = Nachtlauf.nacht(Instant.parse("2026-11-19T22:30:00Z"));
        assertThat(abends.beginn()).isEqualTo(Instant.parse("2026-11-20T01:00:00Z"));
    }

    @Test
    void amTagKeinAuftragUndEinVorFuenfBegonnenerLaufLaeuftZuEnde() {
        Instant kurzVorFuenf = Instant.parse("2026-11-19T03:59:00Z");
        assertThat(Nachtlauf.takt(true, kurzVorFuenf, List.of(box("edge-a", kurzVorFuenf)), List.of()).art())
                .isEqualTo(Nachtlauf.Art.ANLEGEN);

        // 05:01: der um 04:59 angelegte Lauf ist noch offen - die Regel bricht ihn nicht ab (sie kennt kein
        // Abbrechen), legt aber auch keinen neuen an.
        Instant nachFuenf = Instant.parse("2026-11-19T04:01:00Z");
        Nachtlauf.Lauf laeuft = lauf("edge-a", NEU, true, "laeuft", kurzVorFuenf);
        Nachtlauf.Urteil u = Nachtlauf.takt(true, nachFuenf, List.of(box("edge-b", nachFuenf)), List.of(laeuft));
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.TAG);
        assertThat(u.edgeRef()).isNull();
    }

    // ── Einer nach dem anderen ───────────────────────────────────────────

    @Test
    void jeTaktHoechstensEinAuftragInDerReihenfolgeDerKennung() {
        Nachtlauf.Urteil u = Nachtlauf.takt(true, NACHT, List.of(box("edge-c", NACHT), box("edge-a", NACHT),
                box("edge-b", NACHT)), List.of());
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.ANLEGEN);
        assertThat(u.edgeRef()).isEqualTo("edge-a");
        assertThat(u.fassung()).isEqualTo(NEU);
    }

    @Test
    void solangeEinFernlaufOffenIstWartetDerTakt() {
        for (String zustand : List.of("erteilt", "laeuft")) {
            // Auch ein Lauf von Hand: der Werkstatt-Dienst fährt einen zur Zeit.
            Nachtlauf.Lauf offen = lauf("edge-z", NEU, false, zustand, NACHT.minusSeconds(120));
            Nachtlauf.Urteil u = Nachtlauf.takt(true, NACHT, List.of(box("edge-a", NACHT)), List.of(offen));
            assertThat(u.art()).as(zustand).isEqualTo(Nachtlauf.Art.WARTEN);
            assertThat(u.grund()).contains("edge-z");
        }
        // Ist er zu Ende, kommt die nächste Box dran.
        Nachtlauf.Lauf fertig = lauf("edge-a", NEU, true, "fertig", NACHT.minusSeconds(600));
        Nachtlauf.Urteil u = Nachtlauf.takt(true, NACHT, List.of(box("edge-b", NACHT)), List.of(fertig));
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.ANLEGEN);
        assertThat(u.edgeRef()).isEqualTo("edge-b");
    }

    @Test
    void jedeBoxHoechstensEinmalJeNacht() {
        Nachtlauf.Lauf nichtsGeaendert = lauf("edge-a", NEU, true, "unveraendert", NACHT.minusSeconds(1800));
        Nachtlauf.Box a = box("edge-a", NACHT, nichtsGeaendert);
        assertThat(dran(NACHT, a, List.of(nichtsGeaendert))).isEqualTo(new Nachtlauf.Dran(false, Nachtlauf.GRUND_SCHON));
        // In der nächsten Nacht wieder.
        Instant morgen = NACHT.plus(Duration.ofDays(1));
        assertThat(dran(morgen, box("edge-a", morgen, nichtsGeaendert), List.of()).dran()).isTrue();
    }

    // ── Kein Drängeln ────────────────────────────────────────────────────

    @Test
    void nachRuecknahmeOderOffenemEndeNichtDieselbeFassungNochEinmal() {
        Instant gestern = NACHT.minus(Duration.ofDays(1));
        for (String zustand : List.of("zurueck", "offen")) {
            for (boolean nachts : List.of(true, false)) {
                Nachtlauf.Box b = box("edge-a", NACHT, lauf("edge-a", NEU, nachts, zustand, gestern));
                Nachtlauf.Dran d = dran(NACHT, b, List.of());
                assertThat(d.dran()).as(zustand + " nachts=" + nachts).isFalse();
                assertThat(d.grund()).contains("2026.11.15").contains("nicht noch einmal").contains("Noch einmal");
            }
        }
    }

    /** Die Automatik kennt beide Linien: Der Satz nennt auch bei Edge Industrie nur die Nummer der Fassung. */
    @Test
    void edgeIndustrieWirdGenausoNichtGedraengelt() {
        String industrie = "edge-industrie-2026.11.15";
        Nachtlauf.Box pfc = new Nachtlauf.Box("edge-a", MOEGLICH, industrie, NACHT.minusSeconds(20),
                List.of(lauf("edge-a", industrie, true, "zurueck", NACHT.minus(Duration.ofDays(1)))));
        Nachtlauf.Dran d = dran(NACHT, pfc, List.of());
        assertThat(d.dran()).isFalse();
        assertThat(d.grund()).contains("Der letzte Lauf auf 2026.11.15 wurde").doesNotContain("edge-industrie-");
        // Eine Rücknahme bei Edge Light in dieser Nacht hält Edge Industrie nicht an (und umgekehrt).
        Nachtlauf.Box frei = new Nachtlauf.Box("edge-b", MOEGLICH, industrie, NACHT.minusSeconds(20), List.of());
        assertThat(dran(NACHT, frei, List.of(lauf("edge-c", NEU, true, "zurueck", NACHT.minusSeconds(600)))).dran())
                .isTrue();
    }

    @Test
    void eineNeuereFassungGibtDieBoxWiederFrei() {
        Instant gestern = NACHT.minus(Duration.ofDays(1));
        Nachtlauf.Box b = new Nachtlauf.Box("edge-a", MOEGLICH, NOCH_NEUER, NACHT.minusSeconds(20),
                List.of(lauf("edge-a", NEU, true, "zurueck", gestern)));
        assertThat(dran(NACHT, b, List.of()).dran()).isTrue();
    }

    @Test
    void nochEinmalVonHandGibtDieBoxWiederFrei() {
        // Der Admin drückte „Noch einmal"; der Lauf änderte nichts (z. B. nicht abgeholt) - jetzt ist der letzte
        // Lauf auf dieser Fassung keiner mehr, nach dem die Automatik nicht drängelt.
        Nachtlauf.Box b = box("edge-a", NACHT,
                lauf("edge-a", NEU, false, "unveraendert", NACHT.minus(Duration.ofHours(10))),
                lauf("edge-a", NEU, true, "zurueck", NACHT.minus(Duration.ofDays(1))));
        assertThat(dran(NACHT, b, List.of()).dran()).isTrue();
        // Scheitert „Noch einmal" selbst mit Rücknahme, bleibt es dabei.
        Nachtlauf.Box wieder = box("edge-a", NACHT,
                lauf("edge-a", NEU, false, "zurueck", NACHT.minus(Duration.ofHours(10))));
        assertThat(dran(NACHT, wieder, List.of()).dran()).isFalse();
    }

    // ── Halt nach einem Fehlschlag ───────────────────────────────────────

    @Test
    void nachEinerRuecknahmeInDieserNachtKeinWeitererAuftragFuerDieseFassung() {
        Nachtlauf.Lauf gescheitert = lauf("edge-a", NEU, true, "zurueck", NACHT.minusSeconds(1800));
        Nachtlauf.Box a = box("edge-a", NACHT, gescheitert);
        Nachtlauf.Box b = box("edge-b", NACHT);
        Nachtlauf.Urteil u = Nachtlauf.takt(true, NACHT, List.of(a, b), List.of(gescheitert));
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.NICHTS);
        Nachtlauf.Dran d = Nachtlauf.plan(true, NACHT, List.of(a, b), List.of(gescheitert)).get("edge-b");
        assertThat(d.dran()).isFalse();
        assertThat(d.grund()).contains("2026.11.15").contains("angehalten");

        // Auch ein offenes Ende hält an, und auch ein Lauf von Hand in dieser Nacht.
        Nachtlauf.Lauf offen = lauf("edge-a", NEU, false, "offen", NACHT.minusSeconds(3000));
        assertThat(Nachtlauf.takt(true, NACHT, List.of(b), List.of(offen)).art()).isEqualTo(Nachtlauf.Art.NICHTS);
    }

    @Test
    void derHaltGiltNurFuerDieseFassungUndDieseNacht() {
        // Eine andere Fassung scheiterte heute Nacht: diese ist nicht angehalten.
        Nachtlauf.Lauf andere = lauf("edge-a", ALT, true, "zurueck", NACHT.minusSeconds(1800));
        assertThat(Nachtlauf.takt(true, NACHT, List.of(box("edge-b", NACHT)), List.of(andere)).edgeRef())
                .isEqualTo("edge-b");
        // Dieselbe Fassung scheiterte letzte Nacht an einer anderen Box: heute Nacht wieder (eine Box je Nacht).
        Nachtlauf.Lauf gestern = lauf("edge-a", NEU, true, "zurueck", NACHT.minus(Duration.ofDays(1)));
        assertThat(Nachtlauf.takt(true, NACHT, List.of(box("edge-b", NACHT)), List.of(gestern)).edgeRef())
                .isEqualTo("edge-b");
    }

    // ── Obergrenze ───────────────────────────────────────────────────────

    @Test
    void hoechstensZwanzigNachtlaeufeJeNacht() {
        List<Nachtlauf.Lauf> zwanzig = new ArrayList<>();
        for (int i = 0; i < Nachtlauf.GRENZE; i++) {
            zwanzig.add(lauf("edge-x" + i, NEU, true, "fertig", NACHT.minusSeconds(60L * (i + 1))));
        }
        Nachtlauf.Urteil u = Nachtlauf.takt(true, NACHT, List.of(box("edge-a", NACHT)), zwanzig);
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.GRENZE);
        assertThat(Nachtlauf.GRENZE).isEqualTo(20);

        // Läufe von Hand zählen nicht, Nachtläufe der letzten Nacht auch nicht.
        List<Nachtlauf.Lauf> neunzehn = new ArrayList<>(zwanzig.subList(0, 19));
        neunzehn.add(lauf("edge-h", NEU, false, "fertig", NACHT.minusSeconds(30)));
        neunzehn.add(lauf("edge-g", NEU, true, "fertig", NACHT.minus(Duration.ofDays(1))));
        assertThat(Nachtlauf.takt(true, NACHT, List.of(box("edge-a", NACHT)), neunzehn).art())
                .isEqualTo(Nachtlauf.Art.ANLEGEN);
    }

    @Test
    void derPlanVerteiltDieFreienPlaetzeInDerReihenfolgeDesTakts() {
        List<Nachtlauf.Lauf> achtzehn = new ArrayList<>();
        for (int i = 0; i < 18; i++) {
            achtzehn.add(lauf("edge-x" + i, NEU, true, "fertig", NACHT.minusSeconds(60L * (i + 1))));
        }
        Map<String, Nachtlauf.Dran> plan = Nachtlauf.plan(true, NACHT,
                List.of(box("edge-c", NACHT), box("edge-a", NACHT), box("edge-b", NACHT)), achtzehn);
        assertThat(plan.get("edge-a").dran()).isTrue();
        assertThat(plan.get("edge-b").dran()).isTrue();
        assertThat(plan.get("edge-c")).isEqualTo(new Nachtlauf.Dran(false, Nachtlauf.GRUND_GRENZE));
    }

    // ── Schalter ─────────────────────────────────────────────────────────

    @Test
    void angehaltenLegtDieAutomatikNichtsAnUndKeineBoxIstDran() {
        Nachtlauf.Urteil u = Nachtlauf.takt(false, NACHT, List.of(box("edge-a", NACHT)), List.of());
        assertThat(u.art()).isEqualTo(Nachtlauf.Art.AUS);
        assertThat(Nachtlauf.plan(false, NACHT, List.of(box("edge-a", NACHT)), List.of()).get("edge-a"))
                .isEqualTo(new Nachtlauf.Dran(false, Nachtlauf.GRUND_AUS));
    }

    // ── Frische Rückmeldung ──────────────────────────────────────────────

    @Test
    void ohneFrischeRueckmeldungDesTunnelDienstesKeinAuftrag() {
        Nachtlauf.Box nie = new Nachtlauf.Box("edge-a", MOEGLICH, NEU, null, List.of());
        Nachtlauf.Box alt = new Nachtlauf.Box("edge-b", MOEGLICH, NEU, NACHT.minusSeconds(181), List.of());
        Nachtlauf.Box grenze = new Nachtlauf.Box("edge-c", MOEGLICH, NEU, NACHT.minusSeconds(180), List.of());
        Map<String, Nachtlauf.Dran> plan = Nachtlauf.plan(true, NACHT, List.of(nie, alt, grenze), List.of());
        assertThat(plan.get("edge-a")).isEqualTo(new Nachtlauf.Dran(false, Nachtlauf.GRUND_RUECKMELDUNG));
        assertThat(plan.get("edge-b")).isEqualTo(new Nachtlauf.Dran(false, Nachtlauf.GRUND_RUECKMELDUNG));
        assertThat(plan.get("edge-c").dran()).isTrue();
        assertThat(Nachtlauf.takt(true, NACHT, List.of(nie, alt), List.of()).art()).isEqualTo(Nachtlauf.Art.NICHTS);
    }

    @Test
    void wasDerKnopfNichtDarfDarfDieAutomatikAuchNicht() {
        FernlaufRegel.Urteil nein = new FernlaufRegel.Urteil(false, List.of(new FernlaufRegel.Grund("fragt_nicht",
                "Die Box fragt nicht nach Schlüsseln.")), new FernlaufRegel.Haken(true, false, true));
        Nachtlauf.Box b = new Nachtlauf.Box("edge-a", nein, NEU, NACHT.minusSeconds(20), List.of());
        assertThat(dran(NACHT, b, List.of())).isEqualTo(new Nachtlauf.Dran(false,
                "Die Box fragt nicht nach Schlüsseln."));
        Nachtlauf.Box ohneNeueste = new Nachtlauf.Box("edge-a", new FernlaufRegel.Urteil(false, List.of(
                new FernlaufRegel.Grund("keine_neueste", "Es gibt keine neueste zuweisbare Fassung.")),
                new FernlaufRegel.Haken(true, true, true)), null, NACHT.minusSeconds(20), List.of());
        assertThat(dran(NACHT, ohneNeueste, List.of()).grund()).isEqualTo("Es gibt keine neueste zuweisbare Fassung.");
    }

    @Test
    void derAkteurIstAutomatikNachts() {
        assertThat(Nachtlauf.AKTEUR.sub()).isEqualTo("nachtlauf");
        assertThat(Nachtlauf.AKTEUR.name()).isEqualTo("Automatik · nachts");
    }
}
