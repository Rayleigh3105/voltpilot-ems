package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.PushJeBox.Auslass;
import com.voltpilot.api.uems.PushJeBox.Entitaet;
import com.voltpilot.api.uems.PushJeBox.Grund;
import com.voltpilot.api.uems.PushJeBox.Verteilung;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Die Verteilung des Registry-Pushs je Box (UEMS AP-06 IP-6) — rein, ohne Datenbank und Uhr.
 *
 * <p>Die Beispiele sind das Referenzunternehmen ({@code uems-referenzunternehmen.json}): die
 * Zuständigkeiten kommen mit Box, Quelle und Zeitpunkten aus {@code zuordnungen}, die Komponenten
 * K-1, K-3 … K-7 (AN-1) und K-8.1 … K-8.4, K-9 (AN-2) mit ihren Quellen aus der Datei. Die Datenbank
 * zeigt zwei Dinge anders, beide benannt: K-1 und der über ihn gemeldete Speicher K-2 sind EINE Zeile
 * ({@code battery-hybrid}) mit einem PV-Geschwister, und die Haus-Summe ist eine komponierte Zeile
 * ohne eigene Quelle ({@code HS}). Die Lese-Box {@code L} mit dem Kantinen-Zähler K-96 hinter DQ-96 ist
 * der erfundene Fall A9.
 *
 * <p>Der Beweis der Disjunktheit ist {@link #disjunktUndVollstaendigUeberAlleKleinenWelten}: jede
 * Kombination aus drei Entitäten, zwei Quellen mit je sieben Lagen, vier führenden Boxen und acht
 * Soll-Mengen — gezählt, nicht gestichprobt.
 */
class PushJeBoxTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final UUID E1 = id("E-1");
    private static final UUID L = id("L");
    private static final List<String> HALLE_1 = List.of("K-1", "K-1/PV", "K-3", "HS", "K-4", "K-5", "K-6", "K-7");

    private static JsonNode referenz;

    @BeforeAll
    static void ladeReferenz() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
    }

    // ================================================================ Referenz: A1, A3, A9

    /** A1: Box Halle 1 bekommt genau DQ-1 … DQ-3 samt Anlagen-Rollen, Box Halle 2 (neu) genau DQ-4, DQ-5. */
    @Test
    void a1JedeBoxBekommtGenauIhreQuellen() {
        Instant am = t("2026-11-10T10:00:00+01:00");

        Verteilung an1 = PushJeBox.verteilen(halle1(), E1, List.of(E1), referenzZustaendigkeiten(), am, List.of());
        assertThat(an1.jeBox()).isTrue();
        assertThat(an1.boxen()).containsOnlyKeys(E1);
        assertThat(an1.boxen().get(E1)).containsExactlyElementsOf(ids(HALLE_1));
        assertThat(an1.ausgelassen()).isEmpty();

        // AN-2 nach dem Box-Tausch vom 04.11.2026: die ausgebaute Box Halle 2 hat noch ein Soll, ist aber
        // nicht mehr angemeldet — sie bekommt keinen Push.
        UUID e2 = id("E-2");
        UUID e2neu = id("E-2′");
        Verteilung an2 = PushJeBox.verteilen(halle2(), e2neu, List.of(e2neu), referenzZustaendigkeiten(), am,
                List.of(e2));
        assertThat(an2.boxen()).containsOnlyKeys(e2neu);
        assertThat(an2.boxen().get(e2neu)).containsExactlyElementsOf(ids(List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4", "K-9")));

        // Eine Minute vor dem Tausch las noch Box Halle 2.
        Verteilung vorTausch = PushJeBox.verteilen(halle2(), e2, List.of(e2), referenzZustaendigkeiten(),
                t("2026-11-04T09:37:00+01:00"), List.of());
        assertThat(vorTausch.boxen().get(e2)).hasSize(5);
        assertThat(vorTausch.ausgelassen()).isEmpty();
    }

    /**
     * A3: am 10.04.2027 um 07:30 liest Box Halle 2 (neu) DQ-3 — eine Box mit Heimat AN-2. Bis IP-7 den
     * Anlagen-übergreifenden Fall freischaltet, stehen K-4 … K-7 in KEINEM Push, nie still bei Box
     * Halle 1; um 07:29 und nach der Rückkehr am 12.04.2027 16:00 liest wieder Box Halle 1.
     */
    @Test
    void a3DerAnlagenUebergreifendeWechselWartetAufIp7() {
        Instant wechsel = t("2027-04-10T07:30:00+02:00");
        List<ZustaendigkeitRepository.Zeitraum> z = referenzZustaendigkeiten();

        Verteilung davor = PushJeBox.verteilen(halle1(), E1, List.of(E1), z, wechsel.minusSeconds(60), List.of(E1));
        assertThat(davor.boxen().get(E1)).containsExactlyElementsOf(ids(HALLE_1));

        Verteilung ab = PushJeBox.verteilen(halle1(), E1, List.of(E1), z, wechsel, List.of(E1));
        assertThat(ab.boxen().get(E1)).containsExactlyElementsOf(ids(List.of("K-1", "K-1/PV", "K-3", "HS")));
        assertThat(ab.ausgelassen()).extracting(Auslass::entitaet)
                .containsExactlyElementsOf(ids(List.of("K-4", "K-5", "K-6", "K-7")));
        assertThat(ab.ausgelassen()).extracting(Auslass::grund).containsOnly(Grund.BOX_AUSSERHALB_DER_ANLAGE);

        Verteilung zurueck = PushJeBox.verteilen(halle1(), E1, List.of(E1), z, t("2027-04-12T16:00:00+02:00"),
                List.of(E1));
        assertThat(zurueck.boxen().get(E1)).containsExactlyElementsOf(ids(HALLE_1));
    }

    /**
     * A9: die Lese-Box bekommt ihren eigenen Push mit genau K-96, die Anlagen-Rollen bleiben bei Box
     * Halle 1. Wählt der Kunde die Lese-Box als führende Box, wandert die Haus-Summe mit; K-1 und K-3
     * liest weiter Box Halle 1 — sie stehen dann in keinem Push, nie bei der falschen Box.
     */
    @Test
    void a9DieAnlagenRollenStehenNurImPushDerFuehrendenBox() {
        List<Entitaet> welt = new ArrayList<>(halle1());
        welt.add(new Entitaet(id("K-96"), "modbus-generic", id("DQ-96")));
        List<ZustaendigkeitRepository.Zeitraum> z = new ArrayList<>(referenzZustaendigkeiten());
        z.add(zeitraum(id("DQ-96"), L, t("2026-08-03T10:16:00+02:00"), null));
        Instant am = t("2026-09-15T12:00:00+02:00");

        Verteilung v = PushJeBox.verteilen(welt, E1, List.of(E1, L), z, am, List.of());
        assertThat(v.boxen().keySet()).containsExactly(E1, L);
        assertThat(v.boxen().get(E1)).containsExactlyElementsOf(ids(HALLE_1));
        assertThat(v.boxen().get(L)).containsExactly(id("K-96"));
        assertThat(rollen(welt, v.boxen().get(E1))).containsExactly("battery-hybrid", "grid-meter", "house-load");
        assertThat(rollen(welt, v.boxen().get(L))).isEmpty();

        Verteilung gewaehlt = PushJeBox.verteilen(welt, L, List.of(E1, L), z, am, List.of(E1, L));
        assertThat(gewaehlt.boxen().keySet()).containsExactly(L, E1);
        assertThat(gewaehlt.boxen().get(L)).containsExactly(id("HS"), id("K-96"));
        assertThat(gewaehlt.boxen().get(E1))
                .containsExactlyElementsOf(ids(List.of("K-1/PV", "K-4", "K-5", "K-6", "K-7")));
        assertThat(gewaehlt.ausgelassen()).containsExactly(
                new Auslass(id("K-1"), Grund.ANLAGEN_ROLLE_AN_ANDERER_BOX),
                new Auslass(id("K-3"), Grund.ANLAGEN_ROLLE_AN_ANDERER_BOX));
    }

    // ================================================================ Bestand und Ränder

    /** Ohne jede Datenquelle bleibt es der eine Push an die führende Box — auch mit zweiter Box mit Soll. */
    @Test
    void ohneJedeDatenquelleBleibtEsDerEinePushAnDieFuehrendeBox() {
        List<Entitaet> bestand = halle1().stream().map(e -> new Entitaet(e.id(), e.entityType(), null)).toList();
        Verteilung v = PushJeBox.verteilen(bestand, E1, List.of(E1, L), referenzZustaendigkeiten(),
                t("2026-09-15T12:00:00+02:00"), List.of(E1, L));
        assertThat(v.jeBox()).isFalse();
        assertThat(v.boxen()).containsOnlyKeys(E1);
        assertThat(v.boxen().get(E1)).containsExactlyElementsOf(ids(HALLE_1));
        assertThat(v.ausgelassen()).isEmpty();
    }

    /** Ohne führende Box kein Push, auch keiner je Box — in beiden Welten. */
    @Test
    void ohneFuehrendeBoxKeinPushAuchKeinerJeBox() {
        Instant am = t("2026-09-15T12:00:00+02:00");
        List<Entitaet> bestand = halle1().stream().map(e -> new Entitaet(e.id(), e.entityType(), null)).toList();
        for (List<Entitaet> welt : List.of(halle1(), bestand)) {
            Verteilung v = PushJeBox.verteilen(welt, null, List.of(E1, L), referenzZustaendigkeiten(), am,
                    List.of(E1, L));
            assertThat(v.boxen()).isEmpty();
            assertThat(v.ausgelassen()).hasSize(8).extracting(Auslass::grund).containsOnly(Grund.KEINE_FUEHRENDE_BOX);
        }
    }

    /**
     * Eine Box der Anlage mit Soll, aber ohne Quelle, bekommt ihre LEERE Vollmenge — so vergisst sie
     * sicher, was sie las. Eine Box mit Soll, die nicht mehr in der Anlage ist, bekommt nichts.
     */
    @Test
    void eineBoxMitSollBekommtIhreLeereVollmenge() {
        UUID umgezogen = id("umgezogen");
        Verteilung v = PushJeBox.verteilen(halle1(), E1, List.of(E1, L), referenzZustaendigkeiten(),
                t("2026-09-15T12:00:00+02:00"), List.of(L, umgezogen));
        assertThat(v.boxen().keySet()).containsExactly(E1, L);
        assertThat(v.boxen().get(L)).isEmpty();
    }

    /** Vor dem 12.03.2024 liest keine Box DQ-1 … DQ-3: nur die Haus-Summe ohne Quelle geht an Box Halle 1. */
    @Test
    void eineQuelleOhneZustaendigeBoxStehtInKeinemPush() {
        Verteilung v = PushJeBox.verteilen(halle1(), E1, List.of(E1), referenzZustaendigkeiten(),
                t("2024-03-11T23:59:00+01:00"), List.of());
        assertThat(v.boxen().get(E1)).containsExactly(id("HS"));
        assertThat(v.ausgelassen()).hasSize(7).extracting(Auslass::grund)
                .containsOnly(Grund.QUELLE_OHNE_ZUSTAENDIGE_BOX);
    }

    @Test
    void dieGruendeSindGeschlossen() {
        assertThat(Arrays.stream(Grund.values()).map(Grund::code)).containsExactly("keine_fuehrende_box",
                "quelle_ohne_zustaendige_box", "anlagen_rolle_an_anderer_box", "box_ausserhalb_der_anlage");
        assertThat(PushJeBox.ANLAGEN_ROLLEN).containsExactlyInAnyOrder("grid-meter", "house-load", "battery-hybrid");
    }

    // ================================================================ Der Beweis

    /**
     * Disjunkt und vollständig über ALLE kleinen Welten: drei Entitäten (Anlagen-Rolle oder nicht, ohne
     * Quelle, q1 oder q2), je Quelle sieben Lagen (niemand, b1, b2, eine Box außerhalb, Wechsel b1 → b2
     * genau jetzt, geplanter Wechsel in einer Minute, beendet genau jetzt), vier führende Boxen (keine,
     * b1, b2, die Speicher-Box außerhalb der Anlage) und acht Soll-Mengen. Geprüft je Welt: jede Entität
     * genau einmal entschieden, keine in zwei Pushes, keine bei einer Box, die ihre Quelle nicht liest,
     * Anlagen-Rollen nur bei der führenden Box, Pushes nur an Boxen der Anlage oder die führende, und
     * nichts ausgelassen, was eine Box hätte — mit dem richtigen Grund.
     */
    @Test
    void disjunktUndVollstaendigUeberAlleKleinenWelten() {
        UUID b1 = id("b1");
        UUID b2 = id("b2");
        UUID bx = id("bx");
        UUID q1 = id("q1");
        UUID q2 = id("q2");
        List<UUID> anlage = List.of(b1, b2);
        Instant jetzt = t("2026-10-15T12:00:00+02:00");
        Instant vorher = jetzt.minus(Duration.ofDays(30));
        Instant gleich = jetzt.plusSeconds(60);
        List<Function<UUID, List<ZustaendigkeitRepository.Zeitraum>>> lagen = List.of(
                q -> List.of(),
                q -> List.of(zeitraum(q, b1, vorher, null)),
                q -> List.of(zeitraum(q, b2, vorher, null)),
                q -> List.of(zeitraum(q, bx, vorher, null)),
                q -> List.of(zeitraum(q, b1, vorher, jetzt), zeitraum(q, b2, jetzt, null)),
                q -> List.of(zeitraum(q, b1, vorher, gleich), zeitraum(q, b2, gleich, null)),
                q -> List.of(zeitraum(q, b1, vorher, jetzt)));
        String[] typen = {"grid-meter", "modbus-generic"};
        UUID[] quellen = {null, q1, q2};
        UUID[] fuehrende = {null, b1, b2, bx};

        List<String> fehler = new ArrayList<>();
        int welten = 0;
        int zugeteilt = 0;
        int ausgelassen = 0;
        for (int kombination = 0; kombination < 216; kombination++) {
            List<Entitaet> entitaeten = new ArrayList<>();
            int rest = kombination;
            for (int i = 0; i < 3; i++) {
                int wahl = rest % 6;
                rest /= 6;
                entitaeten.add(new Entitaet(id("e" + i), typen[wahl / 3], quellen[wahl % 3]));
            }
            for (int lage1 = 0; lage1 < lagen.size(); lage1++) {
                for (int lage2 = 0; lage2 < lagen.size(); lage2++) {
                    List<ZustaendigkeitRepository.Zeitraum> z = new ArrayList<>(lagen.get(lage1).apply(q1));
                    z.addAll(lagen.get(lage2).apply(q2));
                    for (UUID fuehrend : fuehrende) {
                        for (int maske = 0; maske < 8; maske++) {
                            List<UUID> mitSoll = new ArrayList<>();
                            for (int bit = 0; bit < 3; bit++) {
                                if ((maske & (1 << bit)) != 0) {
                                    mitSoll.add(List.of(b1, b2, bx).get(bit));
                                }
                            }
                            Verteilung v = PushJeBox.verteilen(entitaeten, fuehrend, anlage, z, jetzt, mitSoll);
                            pruefe(entitaeten, fuehrend, anlage, z, jetzt, mitSoll, v, fehler);
                            welten++;
                            zugeteilt += v.boxen().values().stream().mapToInt(List::size).sum();
                            ausgelassen += v.ausgelassen().size();
                        }
                    }
                }
            }
        }
        assertThat(fehler).as("Verletzungen").isEmpty();
        assertThat(welten).isEqualTo(216 * 49 * 4 * 8);
        assertThat(zugeteilt + ausgelassen).as("jede Entität jeder Welt genau einmal entschieden")
                .isEqualTo(welten * 3);
    }

    private static void pruefe(List<Entitaet> entitaeten, UUID fuehrend, List<UUID> anlage,
            List<ZustaendigkeitRepository.Zeitraum> z, Instant jetzt, List<UUID> mitSoll, Verteilung v,
            List<String> fehler) {
        if (fehler.size() > 20) {
            return;
        }
        String welt = entitaeten + " führend=" + fuehrend + " soll=" + mitSoll + " z=" + z;
        Map<UUID, UUID> wo = new HashMap<>();
        v.boxen().forEach((box, ids) -> ids.forEach(e -> {
            if (wo.put(e, box) != null) {
                fehler.add("in zwei Pushes: " + e + " · " + welt);
            }
        }));
        Map<UUID, Grund> aus = new HashMap<>();
        for (Auslass a : v.ausgelassen()) {
            if (aus.put(a.entitaet(), a.grund()) != null || wo.containsKey(a.entitaet())) {
                fehler.add("doppelt entschieden: " + a + " · " + welt);
            }
        }
        if (wo.size() + aus.size() != entitaeten.size()) {
            fehler.add("nicht jede Entität genau einmal: " + v + " · " + welt);
        }
        boolean jeBox = entitaeten.stream().anyMatch(e -> e.quelle() != null);
        if (fuehrend == null) {
            if (!v.boxen().isEmpty() || !aus.values().stream().allMatch(g -> g == Grund.KEINE_FUEHRENDE_BOX)) {
                fehler.add("Push ohne führende Box: " + v + " · " + welt);
            }
            return;
        }
        List<UUID> ziele = new ArrayList<>(v.boxen().keySet());
        if (ziele.isEmpty() || !ziele.get(0).equals(fuehrend)) {
            fehler.add("die führende Box nicht zuerst: " + v + " · " + welt);
        }
        for (UUID box : ziele) {
            if (!box.equals(fuehrend) && !anlage.contains(box)) {
                fehler.add("Push an eine Box außerhalb: " + box + " · " + welt);
            }
        }
        if (!jeBox && ziele.size() != 1) {
            fehler.add("Bestandsweg mit mehr als einem Push: " + v + " · " + welt);
        }
        if (jeBox) {
            Set<UUID> mitEntitaeten = new HashSet<>(wo.values());
            for (UUID box : anlage) {
                boolean erwartet = box.equals(fuehrend) || mitEntitaeten.contains(box) || mitSoll.contains(box);
                if (erwartet != v.boxen().containsKey(box)) {
                    fehler.add("Push-Ziel falsch: " + box + " · " + v + " · " + welt);
                }
            }
        }
        for (Entitaet e : entitaeten) {
            UUID liest = e.quelle() == null ? null : orakel(z, e.quelle(), jetzt);
            boolean rolle = PushJeBox.ANLAGEN_ROLLEN.contains(e.entityType());
            UUID box = wo.get(e.id());
            if (jeBox && box != null && e.quelle() != null && !box.equals(liest)) {
                fehler.add("fremde Quelle: " + e + " bei " + box + ", liest " + liest + " · " + welt);
            }
            if (box != null && rolle && !box.equals(fuehrend)) {
                fehler.add("Anlagen-Rolle nicht bei der führenden Box: " + e + " · " + welt);
            }
            UUID soll;
            Grund grund = null;
            if (!jeBox || e.quelle() == null) {
                soll = fuehrend;
            } else if (rolle) {
                soll = fuehrend.equals(liest) ? fuehrend : null;
                grund = liest == null ? Grund.QUELLE_OHNE_ZUSTAENDIGE_BOX : Grund.ANLAGEN_ROLLE_AN_ANDERER_BOX;
            } else if (liest == null) {
                soll = null;
                grund = Grund.QUELLE_OHNE_ZUSTAENDIGE_BOX;
            } else if (liest.equals(fuehrend) || anlage.contains(liest)) {
                soll = liest;
            } else {
                soll = null;
                grund = Grund.BOX_AUSSERHALB_DER_ANLAGE;
            }
            if (!Objects.equals(box, soll)) {
                fehler.add("falsche Box: " + e + " bei " + box + ", erwartet " + soll + " · " + welt);
            }
            if (soll == null && aus.get(e.id()) != grund) {
                fehler.add("falscher Grund: " + e + " " + aus.get(e.id()) + ", erwartet " + grund + " · " + welt);
            }
        }
    }

    /** Welche Box liest — unabhängig von {@link DatenquelleRegeln} nachgerechnet: halboffen. */
    private static UUID orakel(List<ZustaendigkeitRepository.Zeitraum> z, UUID quelle, Instant t) {
        for (ZustaendigkeitRepository.Zeitraum r : z) {
            if (r.dataSourceId().equals(quelle) && !t.isBefore(r.effectiveFrom())
                    && (r.effectiveTo() == null || t.isBefore(r.effectiveTo()))) {
                return r.deviceId();
            }
        }
        return null;
    }

    // ================================================================ Gerüst

    /** AN-1, so wie die Datenbank sie zeigt, in Push-Reihenfolge. */
    private static List<Entitaet> halle1() {
        return List.of(
                new Entitaet(id("K-1"), "battery-hybrid", quelleDerKomponente("K-1")),
                new Entitaet(id("K-1/PV"), "producer", quelleDerKomponente("K-1")),
                new Entitaet(id("K-3"), "grid-meter", quelleDerKomponente("K-3")),
                new Entitaet(id("HS"), "house-load", null),
                new Entitaet(id("K-4"), "modbus-generic", quelleDerKomponente("K-4")),
                new Entitaet(id("K-5"), "modbus-generic", quelleDerKomponente("K-5")),
                new Entitaet(id("K-6"), "modbus-generic", quelleDerKomponente("K-6")),
                new Entitaet(id("K-7"), "modbus-generic", quelleDerKomponente("K-7")));
    }

    /** AN-2: die Energiekarten hinter DQ-4 und der Ladepunkt hinter DQ-5. */
    private static List<Entitaet> halle2() {
        List<Entitaet> out = new ArrayList<>();
        for (String k : List.of("K-8.1", "K-8.2", "K-8.3", "K-8.4")) {
            out.add(new Entitaet(id(k), "modbus-generic", quelleDerKomponente(k)));
        }
        out.add(new Entitaet(id("K-9"), "ev-charger", quelleDerKomponente("K-9")));
        return out;
    }

    /** Komponente → Gerät → Datenquelle, aus der Referenz. */
    private static UUID quelleDerKomponente(String kennzeichen) {
        String geraet = eines(referenz.get("komponenten"), kennzeichen).get("geraet").asText();
        return id(eines(referenz.get("geraete"), geraet).get("datenquelle").asText());
    }

    /** Die Zuständigkeiten der Referenz ({@code zuordnungen}, Art {@code datenquelle_box}). */
    private static List<ZustaendigkeitRepository.Zeitraum> referenzZustaendigkeiten() {
        List<ZustaendigkeitRepository.Zeitraum> out = new ArrayList<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if (!"datenquelle_box".equals(z.get("art").asText())) {
                continue;
            }
            JsonNode bis = z.get("gueltig_bis");
            out.add(zeitraum(id(z.get("von").asText()), id(z.get("nach").asText()), t(z.get("gueltig_ab").asText()),
                    bis == null || bis.isNull() ? null : t(bis.asText())));
        }
        return out;
    }

    private static ZustaendigkeitRepository.Zeitraum zeitraum(UUID quelle, UUID box, Instant von, Instant bis) {
        return new ZustaendigkeitRepository.Zeitraum(id(quelle + "→" + box + "@" + von), quelle, box, von, bis);
    }

    private static List<String> rollen(List<Entitaet> welt, List<UUID> ids) {
        return welt.stream().filter(e -> ids.contains(e.id()))
                .map(Entitaet::entityType).filter(PushJeBox.ANLAGEN_ROLLEN::contains).toList();
    }

    private static JsonNode eines(JsonNode liste, String kennzeichen) {
        for (JsonNode n : liste) {
            if (kennzeichen.equals(n.get("kennzeichen").asText())) {
                return n;
            }
        }
        throw new IllegalArgumentException("nicht in der Referenz: " + kennzeichen);
    }

    /** Kennzeichen → stabile Kennung. */
    private static UUID id(String kennzeichen) {
        return UUID.nameUUIDFromBytes(kennzeichen.getBytes(StandardCharsets.UTF_8));
    }

    private static List<UUID> ids(List<String> kennzeichen) {
        return kennzeichen.stream().map(PushJeBoxTest::id).toList();
    }

    private static Instant t(String zeitpunkt) {
        return OffsetDateTime.parse(zeitpunkt).toInstant();
    }
}
