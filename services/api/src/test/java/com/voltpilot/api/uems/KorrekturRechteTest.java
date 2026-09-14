package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Grund;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die Rechte der Korrektur-Routen (UEMS AP-08 IP-15) — rein, ohne Spring und Datenbank.
 *
 * <ul>
 *   <li>die fünf Zeilen in {@link KorrekturRechte#MATRIX} sind Zelle für Zelle die der Matrix-Datei (die Datei
 *       liegt nicht im Jar — dieser Test ist der Lockstep);</li>
 *   <li>der heutige Kundenbenutzer ist Kundenadministrator, der Plattform-Admin im Kundenbereich ist ein
 *       Unterstützer — und der Unterstützer wird an JEDER der fünf Handlungen abgewiesen, bei an und bei aus;</li>
 *   <li>bei an weist die Freigabe den Ersteller ab, bei aus nicht; ein System-Vorschlag hält niemanden auf.</li>
 * </ul>
 */
class KorrekturRechteTest {

    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");
    private static final Instant JETZT = Instant.parse("2027-01-25T09:05:00Z");
    private static final List<String> FUENF = List.of(KorrekturRechte.ERSATZWERT_ERFASSEN,
            KorrekturRechte.KORREKTUR_ERFASSEN, KorrekturRechte.KORREKTUR_FREIGEBEN,
            KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, KorrekturRechte.VIERAUGEN_EINSTELLEN);

    private static final ProtokollAkteur INES = ProtokollAkteur.fuer("sub-ines", "Ines Kaltenbach", false);
    private static final ProtokollAkteur JONAS = ProtokollAkteur.fuer("sub-jonas", "Jonas Wendlinger", false);
    private static final ProtokollAkteur ADMIN = ProtokollAkteur.fuer("sub-admin", "Lena Voss", true);

    @Test
    void dieFuenfZeilenSindDieDerMatrixDatei() throws Exception {
        Matrix datei = RechteAbleitung.matrix(new ObjectMapper().readTree(MATRIX.toFile()));
        assertThat(KorrekturRechte.MATRIX.aktionen().keySet()).containsExactlyInAnyOrderElementsOf(FUENF);
        for (String kennung : FUENF) {
            assertThat(KorrekturRechte.MATRIX.aktion(kennung)).as(kennung).isEqualTo(datei.aktion(kennung));
        }
    }

    @Test
    void derKundenbenutzerIstKundenadministratorUndDarfAlleFuenf() {
        for (String kennung : List.of(KorrekturRechte.ERSATZWERT_ERFASSEN, KorrekturRechte.KORREKTUR_ERFASSEN,
                KorrekturRechte.VIERAUGEN_EINSTELLEN)) {
            DarfErgebnis d = KorrekturRechte.darf(JONAS, kennung, JETZT);
            assertThat(d.darf()).as(kennung).isTrue();
            assertThat(d.rolle()).isEqualTo(Rolle.KUNDENADMINISTRATOR);
        }
        for (boolean an : List.of(false, true)) {
            assertThat(KorrekturRechte.entscheiden(JONAS, KorrekturRechte.KORREKTUR_FREIGEBEN, "sub-ines", an, JETZT)
                    .darf()).as("freigeben, vieraugen=" + an).isTrue();
            assertThat(KorrekturRechte.entscheiden(JONAS, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, "sub-ines", an, JETZT)
                    .darf()).as("zurücknehmen, vieraugen=" + an).isTrue();
        }
    }

    /** Unterstützer nie — an jeder Handlung, bei an und bei aus, auch mit dem größten Umfang und als Ersteller. */
    @Test
    void derUnterstuetzerWirdAnJederHandlungAbgewiesen() {
        assertThat(KorrekturRechte.benutzer(ADMIN).zuweisungen()).singleElement()
                .satisfies(z -> assertThat(z.rolle()).isEqualTo(Rolle.UNTERSTUETZER));
        for (String kennung : List.of(KorrekturRechte.ERSATZWERT_ERFASSEN, KorrekturRechte.KORREKTUR_ERFASSEN,
                KorrekturRechte.VIERAUGEN_EINSTELLEN)) {
            nie(KorrekturRechte.darf(ADMIN, kennung, JETZT), kennung);
        }
        for (boolean an : List.of(false, true)) {
            for (String ersteller : new String[] {null, "sub-ines", "sub-admin"}) {
                nie(KorrekturRechte.entscheiden(ADMIN, KorrekturRechte.KORREKTUR_FREIGEBEN, ersteller, an, JETZT),
                        "freigeben " + an + " " + ersteller);
                nie(KorrekturRechte.entscheiden(ADMIN, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, ersteller, an, JETZT),
                        "zurücknehmen " + an + " " + ersteller);
            }
        }
    }

    @Test
    void beiAnGibtDerErstellerNichtFreiBeiAusSchon() {
        DarfErgebnis an = KorrekturRechte.entscheiden(INES, KorrekturRechte.KORREKTUR_FREIGEBEN, "sub-ines", true, JETZT);
        assertThat(an.darf()).isFalse();
        assertThat(an.http()).isEqualTo(403);
        assertThat(an.grund()).isEqualTo(Grund.ZWEITE_PERSON_NOETIG);
        assertThat(an.text()).isEqualTo("Freigabe durch eine zweite Person.");

        assertThat(KorrekturRechte.entscheiden(INES, KorrekturRechte.KORREKTUR_FREIGEBEN, "sub-ines", false, JETZT)
                .darf()).as("Gegenprobe: Vorgabe aus").isTrue();
        assertThat(KorrekturRechte.entscheiden(INES, KorrekturRechte.KORREKTUR_FREIGEBEN, null, true, JETZT)
                .darf()).as("ein Vorschlag des Systems hat keinen Ersteller").isTrue();
        assertThat(KorrekturRechte.entscheiden(INES, KorrekturRechte.KORREKTUR_ZURUECKNEHMEN, "sub-ines", true, JETZT)
                .darf()).as("§5: der Widerruf kennt keine Ersteller-Sperre").isTrue();
    }

    private static void nie(DarfErgebnis d, String was) {
        assertThat(d.darf()).as(was).isFalse();
        assertThat(d.http()).as(was).isEqualTo(403);
        assertThat(d.grund()).as(was).isEqualTo(Grund.RECHT_FEHLT);
        assertThat(d.rolleNoetig()).as(was + ": kein Weg über eine Rolle").isNull();
        assertThat(d.umfangNoetig()).as(was + ": kein Umfang gäbe es").isNull();
    }
}
