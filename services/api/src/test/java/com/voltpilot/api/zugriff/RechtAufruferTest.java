package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.KennzahlAufrufer;
import com.voltpilot.api.uems.KennzahlRechte;
import com.voltpilot.api.uems.KorrekturRechte;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Die Dienste, die ihr Urteil selbst sprechen (Kennzahlen, Berichte, Korrekturen), lesen den Aufrufer seit AP-03 IP-6
 * aus dem Zugriff-Kontext ({@link KorrekturRechte#aufrufer}, {@link KennzahlAufrufer}). Bestand: für jedes heutige Konto
 * urteilt die Ableitung über JEDE Aktion der Matrix an Unternehmen und Standort genau wie mit der Festlegung von vorher
 * ({@link KorrekturRechte#benutzer}). Neu: eine Zuweisung je Standort wirkt.
 *
 * <p>Rein: kein Spring, keine Datenbank.
 */
class RechtAufruferTest {

    private static final Instant JETZT = Instant.parse("2026-09-15T10:00:00Z");
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "rechte-vectors.json");
    private static final UUID TENANT = UUID.fromString("a3060000-0000-0000-0000-000000000001");
    private static final UUID ST1 = UUID.fromString("a3060000-0000-0000-0001-000000000001");
    private static final UUID ST2 = UUID.fromString("a3060000-0000-0000-0001-000000000002");
    private static final Kundenbereich K = new Kundenbereich("Kundenbereich",
            List.of(new Standort(ST1.toString(), "Werk Ahrenberg"), new Standort(ST2.toString(), "Werk Lindach")),
            List.of());

    @AfterEach
    void aufraeumen() {
        ZugriffContext.clear();
    }

    @Test
    void ohneKontextBleibtEsBeiDerFestlegungVonVorher() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-kunde", "Kunde", false);
        assertThat(KorrekturRechte.aufrufer(wer)).isEqualTo(KorrekturRechte.benutzer(wer));
        assertThat(new KennzahlAufrufer().benutzer(wer)).isEqualTo(KorrekturRechte.benutzer(wer));
    }

    /**
     * Der Mandantensprung (Auftrag vom 29.10.2026): am Umschalter urteilen Korrekturen, Kennzahlen, Berichte,
     * Überwachungen und Stummschaltungen über die Plattform wie über den Kundenadministrator — jede Aktion, an
     * Unternehmen und Standort, gleich bis auf die P-Zeilen, die sie dazu über {@code voltpilot_betrieb} hat. Bis dahin
     * war sie hier eine VoltPilot-Unterstützung (Korrektur 403) bzw. ohne Aufrufer (Überwachung 403).
     */
    @Test
    void imSprungUrteilenDieDiensteWieUeberDenKundenadministrator() throws Exception {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-plattform", "Plattform", true);
        ZugriffContext.set(new Zugriff("sub-plattform", Konto.PLATTFORM, TENANT, Zugang.UMSCHALTER, List.of(), JETZT));
        Benutzer sprung = KorrekturRechte.aufrufer(wer);
        assertThat(RechtPruefung.aufrufer()).contains(sprung);
        assertThat(new KennzahlAufrufer().benutzer(wer)).isEqualTo(sprung);
        assertThat(sprung.konto()).isEqualTo(Konto.PLATTFORM);
        assertThat(sprung.zuweisungen()).containsExactly(RechtPruefung.SPRUNGRECHT);

        Benutzer kundenadministrator = KorrekturRechte.benutzer(ProtokollAkteur.fuer("sub-kunde", "Kunde", false));
        RechteAbleitung.Matrix m = RechteMatrixDatei.matrix();
        List<String> plattform = RechteMatrixDatei.aktionen().stream()
                .filter(a -> m.aktionen().get(a).zelle(Rolle.VOLTPILOT_BETRIEB) == RechteAbleitung.Zelle.P).toList();
        assertThat(abweichungen(kundenadministrator, sprung)).allSatisfy(a -> assertThat(plattform)
                .anyMatch(p -> a.startsWith(p + " @ ")));
        assertThat(KorrekturRechte.darf(wer, "korrektur.erfassen", JETZT).darf()).isTrue();
        assertThat(KorrekturRechte.darf(wer, "vieraugen.einstellen", JETZT).darf()).isTrue();

        // Dieselbe gedachte Zuweisung pinnen die Fälle sprung-* in rechte-vectors.json für beide Zwillinge.
        JsonNode vektoren = new ObjectMapper().readTree(VEKTOREN.toFile());
        int faelle = 0;
        for (JsonNode c : vektoren.path("cases")) {
            if (!c.path("name").asText().startsWith("sprung-")) {
                continue;
            }
            JsonNode b = c.path("input").has("benutzer") ? c.path("input").path("benutzer")
                    : c.path("input").path("handelnder");
            assertThat(b.path("konto").asText()).isEqualTo(sprung.konto().code());
            assertThat(b.path("zuweisungen")).hasSize(1);
            JsonNode z = b.path("zuweisungen").get(0);
            assertThat(z.path("rolle").asText()).isEqualTo(RechtPruefung.SPRUNGRECHT.rolle().code());
            assertThat(z.path("standorte").isNull()).isTrue();
            assertThat(Instant.parse(z.path("gueltig_ab").asText())).isEqualTo(RechtPruefung.SPRUNGRECHT.gueltigAb());
            assertThat(z.path("gueltig_bis").isNull() && z.path("beendet_am").isNull() && z.path("art").isNull()
                    && z.path("umfang").isNull()).isTrue();
            faelle++;
        }
        assertThat(faelle).isGreaterThanOrEqualTo(8);
    }

    @Test
    void ohneSprungBleibtDiePlattformEineUnterstuetzung() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-plattform", "Plattform", true);
        ZugriffContext.set(new Zugriff("sub-plattform", Konto.PLATTFORM, TENANT, Zugang.UNTERSTUETZUNG, List.of(), JETZT));
        assertThat(ZugriffContext.get().imSprung()).isFalse();
        assertThat(ZugriffContext.get().kundenadministrator()).isFalse();
        assertThat(KorrekturRechte.aufrufer(wer).zuweisungen()).isEmpty();
        ZugriffContext.clear();
        assertThat(RechtPruefung.aufrufer()).isEmpty();
        assertThat(KorrekturRechte.aufrufer(wer)).isEqualTo(KorrekturRechte.benutzer(wer));
    }

    @Test
    void derKundenadministratorDerBestandsuebernahmeUrteiltUeberJedeAktionWieVorher() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-kunde", "Kunde", false);
        ZugriffContext.set(new Zugriff("sub-kunde", Konto.BENUTZER, TENANT, Zugang.KONTO,
                List.of(zeile("sub-kunde", Rolle.KUNDENADMINISTRATOR, null)), JETZT));
        assertThat(abweichungen(KorrekturRechte.benutzer(wer), KorrekturRechte.aufrufer(wer))).isEmpty();
    }

    @Test
    void einNieZugewiesenesKundenkontoUrteiltUeberJedeAktionWieVorher() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-nie", "Nie", false);
        ZugriffContext.set(new Zugriff("sub-nie", Konto.BENUTZER, TENANT, Zugang.KONTO, List.of(), JETZT, true));
        assertThat(abweichungen(KorrekturRechte.benutzer(wer), KorrekturRechte.aufrufer(wer))).isEmpty();
    }

    @Test
    void einBearbeiterJeStandortDefiniertKennzahlenNurAnSeinemStandort() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-peter", "Peter Hollerbach", false);
        ZugriffContext.set(new Zugriff("sub-peter", Konto.BENUTZER, TENANT, Zugang.KONTO,
                List.of(zeile("sub-peter", Rolle.BEARBEITER, ST2)), JETZT));
        Benutzer peter = new KennzahlAufrufer().benutzer(wer);

        assertThat(KennzahlRechte.darf(peter, K, "kennzahl.standort_definieren", ST2.toString(), JETZT).darf()).isTrue();
        assertThat(KennzahlRechte.darf(peter, K, "kennzahl.standort_definieren", ST1.toString(), JETZT).http())
                .isEqualTo(404);
        DarfErgebnis unternehmen = KennzahlRechte.darf(peter, K, "kennzahl.unternehmen_definieren", null, JETZT);
        assertThat(unternehmen.http()).isEqualTo(403);
        // Korrekturen: das Ziel bleibt das Unternehmen — ein Bearbeiter je Standort wird abgewiesen, nicht zugelassen.
        assertThat(KorrekturRechte.darf(wer, "korrektur.freigeben", JETZT).http()).isEqualTo(403);
    }

    @Test
    void eineLeserinDarfKeineKorrekturFreigebenUndKeineKennzahlDefinieren() {
        ProtokollAkteur wer = ProtokollAkteur.fuer("sub-claudia", "Claudia Berger", false);
        ZugriffContext.set(new Zugriff("sub-claudia", Konto.BENUTZER, TENANT, Zugang.KONTO,
                List.of(zeile("sub-claudia", Rolle.LESER, ST1), zeile("sub-claudia", Rolle.LESER, ST2)), JETZT));
        Benutzer claudia = new KennzahlAufrufer().benutzer(wer);
        assertThat(KennzahlRechte.darf(claudia, K, "kennzahl.standort_definieren", ST1.toString(), JETZT).http())
                .isEqualTo(403);
        assertThat(KorrekturRechte.darf(wer, "vieraugen.einstellen", JETZT).http()).isEqualTo(403);
    }

    /** Jede Aktion der Matrix an Unternehmen und an beiden Standorten: gleich im Ja/Nein, Status, Grund und Rolle. */
    private static List<String> abweichungen(Benutzer vorher, Benutzer nachher) {
        RechteAbleitung.Matrix m = RechteMatrixDatei.matrix();
        List<String> aus = new ArrayList<>();
        List<Ziel> ziele = List.of(Ziel.unternehmen(), Ziel.standort(ST1.toString()), Ziel.standort(ST2.toString()));
        for (String aktion : RechteMatrixDatei.aktionen()) {
            for (Ziel z : ziele) {
                DarfErgebnis a = RechteAbleitung.darf(m, vorher, K, aktion, z, JETZT);
                DarfErgebnis b = RechteAbleitung.darf(m, nachher, K, aktion, z, JETZT);
                if (a.darf() != b.darf() || a.http() != b.http() || a.grund() != b.grund() || a.rolle() != b.rolle()) {
                    aus.add(aktion + " @ " + z + ": vorher " + a + " · nachher " + b);
                }
            }
        }
        assertThat(RechteMatrixDatei.aktionen()).hasSizeGreaterThan(60);
        return aus;
    }

    private static ZugriffRepository.Zeile zeile(String sub, Rolle rolle, UUID standort) {
        return new ZugriffRepository.Zeile(UUID.randomUUID(), sub, rolle, standort,
                standort == null ? null : "ST-x", standort == null ? null : "Werk X", null, null,
                Instant.parse("2024-03-12T00:00:00Z"), null, null,
                ZoneId.of("Europe/Berlin"), null, null, null, null);
    }
}
