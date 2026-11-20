package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerAuditRepository;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Steuerung;
import com.voltpilot.api.erzeuger.KoppelbildRepository.Freigabe;
import com.voltpilot.api.probe.ProbePublisher;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.web.dto.KoppelbildDto;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeSet;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * PFC200 Stufe 4 „Wünschen“ ({@code docs/contracts/v2/koppelbild.md} §15): das Koppelbild einer Anlagensteuerung
 * ansehen, einen Stellplatz testen, freigeben und die Freigabe zurücknehmen - nach dem Muster der Schreibwerte des
 * Modbus-Geräts ({@code ModbusGeraetService}).
 *
 * <ul>
 *   <li><b>Der Test ist eine Quittung.</b> Ein Schalt-Test schreibt über die Box für {@value Koppelbild#TEST_TTL_S} s
 *       einen Testwert auf genau einen Stellplatz (Probe-Art {@code koppel_test}); bestanden ist er, wenn die SPS den
 *       Testwunsch zu genau seiner Folge mit angenommen, begrenzt oder überstimmt quittiert. Ein Testwert außerhalb
 *       des Bands wird abgelehnt, nie hineingeklemmt.</li>
 *   <li><b>Die Freigabe hängt an der Form des Angebots</b> (Art, Ziel, Nummer, Band): sie braucht einen bestandenen
 *       Test genau dieser Form und die Bestätigung, dass ein Mensch die Wirkung an der Anlage gesehen hat. Meldet die
 *       Box ein anderes Angebot, fällt sie ({@link #abgleichen}).</li>
 *   <li><b>Ein Stellplatz je Kommando.</b> Der Schiedsrichter der Box gewährt je Gerät einen Wert je Kommando; zwei
 *       freigegebene Stellplätze mit demselben Kommando lehnt die Freigabe ab (409), die Datenbank ebenso.</li>
 *   <li><b>Nur an eine Box, die es kann.</b> Test und Freigabe verlangen, dass die Box, die die Steuerung liest,
 *       {@value Koppelbild#FAEHIGKEIT} meldet; ohne das trägt auch der Registry-Push keinen Stellplatz.</li>
 * </ul>
 *
 * <p>Nach jeder Änderung einer Freigabe geht der Registry-Push an die Box ({@link AnlagensteuerungQuelle#zustellen}):
 * erst dann trägt die Anlagensteuerung die Fähigkeit {@code actuate} des Stellplatzes - oder nicht mehr.
 */
@Service
public class KoppelbildService {

    private static final Logger log = LoggerFactory.getLogger(KoppelbildService.class);

    /** Der Akteur, wenn die Cloud eine Freigabe fallen lässt, weil das Angebot sich geändert hat. */
    public static final String SYSTEM = "system:koppelbild";
    /** Der Beleg-Schlüssel der Spur ({@code consumer_audit_event}). */
    static final String GRUND_ZURUECKGENOMMEN = "zurueckgenommen";
    static final String GRUND_ANGEBOT = "angebot_geaendert";

    private final AnlagensteuerungRepository steuerungen;
    private final KoppelbildRepository repo;
    private final BoxFaehigkeiten faehigkeiten;
    private final ProbeService probes;
    private final ConsumerAuditRepository audit;
    private final AnlagensteuerungQuelle quelle;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final Clock uhr;

    @Autowired
    public KoppelbildService(AnlagensteuerungRepository steuerungen, KoppelbildRepository repo,
            BoxFaehigkeiten faehigkeiten, ProbeService probes, ConsumerAuditRepository audit,
            AnlagensteuerungQuelle quelle, ObjectMapper json, PlatformTransactionManager transaktionen) {
        this(steuerungen, repo, faehigkeiten, probes, audit, quelle, json, new TransactionTemplate(transaktionen),
                Clock.systemUTC());
    }

    KoppelbildService(AnlagensteuerungRepository steuerungen, KoppelbildRepository repo, BoxFaehigkeiten faehigkeiten,
            ProbeService probes, ConsumerAuditRepository audit, AnlagensteuerungQuelle quelle, ObjectMapper json,
            TransactionTemplate tx, Clock uhr) {
        this.steuerungen = steuerungen;
        this.repo = repo;
        this.faehigkeiten = faehigkeiten;
        this.probes = probes;
        this.audit = audit;
        this.quelle = quelle;
        this.json = json;
        this.tx = tx;
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ ansehen

    /** Das Koppelbild einer Anlagensteuerung der Anlage; eine fremde oder umzäunte ist 404. */
    public KoppelbildDto.Koppelbild koppelbild(UUID siteId, UUID geraetId) {
        if (!steuerungen.anlageSichtbar(siteId)) {
            throw nichtGefunden("Anlage nicht gefunden.");
        }
        Steuerung s = steuerungen.steuerung(geraetId).filter(x -> x.siteId().equals(siteId))
                .orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
        return koppelbild(s);
    }

    private KoppelbildDto.Koppelbild koppelbild(Steuerung s) {
        Instant jetzt = uhr.instant();
        boolean unterstuetzt = boxKann(s);
        Optional<KoppelbildRepository.StandZeile> zeile = repo.juengsterStand(s.entityId());
        Koppelbild.Stand stand = zeile.map(z -> Koppelbild.stand(lies(z.json()))).orElse(null);
        KoppelbildDto.Stand standDto = stand == null ? null : standDto(stand, zeile.get().empfangenAt(), jetzt);
        return new KoppelbildDto.Koppelbild(unterstuetzt, standDto,
                stellplaetze(stand, repo.freigaben(s.geraetId()), unterstuetzt));
    }

    static KoppelbildDto.Stand standDto(Koppelbild.Stand st, Instant empfangen, Instant jetzt) {
        boolean aktuell = !empfangen.isBefore(jetzt.minusSeconds(AnlagensteuerungService.AKTUELL_BIS_S));
        Integer bib = Koppelbild.bibliothek(st.bibliothek());
        List<String> q = st.qBits();
        return new KoppelbildDto.Stand(zeit(empfangen), aktuell, st.lage(), st.grund(), zeit(st.gelesenAt()),
                st.bibliothek(), Koppelbild.bibliothekText(Programmstand.KOPPEL_BIBLIOTHEK),
                bib == null ? null : bib < Programmstand.KOPPEL_BIBLIOTHEK, st.kopfUrteil(), st.restS(),
                q == null ? null : q.contains("fernsteuerung_frei"), q == null ? null : q.contains("edge_lebt"),
                q == null ? null : q.contains("hand_ort"), st.angenommenZaehler(), st.abgelehntZaehler());
    }

    /** Die Stellplätze des Stands und die mit einer Freigabe-Zeile, nach Nummer. */
    static List<KoppelbildDto.Stellplatz> stellplaetze(Koppelbild.Stand stand, List<Freigabe> zeilen,
            boolean unterstuetzt) {
        TreeSet<Integer> nummern = new TreeSet<>();
        if (stand != null && stand.plaetze() != null) {
            stand.plaetze().forEach(p -> nummern.add(p.platz()));
        }
        zeilen.forEach(z -> nummern.add(z.platz()));
        List<KoppelbildDto.Stellplatz> out = new ArrayList<>();
        for (int nr : nummern) {
            Koppelbild.Platz p = stand == null ? null : stand.platz(nr);
            Freigabe z = zeilen.stream().filter(f -> f.platz() == nr).findFirst().orElse(null);
            out.add(stellplatz(nr, p, z, zeilen, unterstuetzt));
        }
        return out;
    }

    static KoppelbildDto.Stellplatz stellplatz(int nr, Koppelbild.Platz p, Freigabe z, List<Freigabe> alle,
            boolean unterstuetzt) {
        Koppelbild.Angebot jetzt = p == null ? null : p.angebot();
        KoppelbildDto.Angebot angebot = jetzt == null ? null : new KoppelbildDto.Angebot(jetzt.art(), jetzt.ziel(),
                jetzt.nr(), jetzt.min(), jetzt.max(), p.bits().contains("bereit"),
                p.bits().stream().filter(b -> b.startsWith("grund_")).toList());
        KoppelbildDto.Wunsch wunsch = p == null || p.wunsch() == null ? null : new KoppelbildDto.Wunsch(
                p.wunsch().art(), p.wunsch().wert(), p.wunsch().grund(), p.wunsch().folge());
        String status;
        if (z != null && z.aktiv()) {
            status = "freigegeben";
        } else if (z != null && z.beleg(jetzt)) {
            status = "getestet";
        } else if (z != null && GRUND_ANGEBOT.equals(z.widerrufenGrund())) {
            status = "verfallen";
        } else {
            status = "offen";
        }
        KoppelbildDto.Test beleg = z == null || z.testAt() == null ? null
                : new KoppelbildDto.Test(z.testWert(), z.testUrteil(), z.testWirksam(), zeit(z.testAt()));
        KoppelbildDto.Freigabe freigabe = new KoppelbildDto.Freigabe(status,
                z == null || !z.aktiv() ? null : zeit(z.freigegebenAt()), z == null || !z.aktiv() ? null
                        : z.freigegebenVon(), beleg, "verfallen".equals(status) ? GRUND_ANGEBOT : null);
        String grund = "freigegeben".equals(status) ? null : freigabeGrund(nr, jetzt, z, alle, unterstuetzt);
        String kommando = jetzt != null ? jetzt.kommando() : z != null ? z.kommando() : null;
        return new KoppelbildDto.Stellplatz(nr, angebot, wunsch, p != null && p.test(), p == null ? null : p.urteil(),
                p == null ? null : p.folge(), p == null ? null : p.wirksam(), kommando, freigabe,
                !"freigegeben".equals(status) && grund == null, grund);
    }

    /** Warum ein Stellplatz gerade nicht freigegeben werden kann - oder null, wenn er es kann. */
    static String freigabeGrund(int nr, Koppelbild.Angebot jetzt, Freigabe z, List<Freigabe> alle,
            boolean unterstuetzt) {
        if (!unterstuetzt) return "box_kann_nicht";
        if (jetzt == null) return "angebot_fehlt";
        if (z == null || !z.beleg(jetzt)) {
            return z != null && z.versuchNichtAngenommen() ? "test_nicht_angenommen" : "kein_test";
        }
        if (belegt(nr, jetzt.kommando(), alle) != null) return "kommando_belegt";
        return null;
    }

    /** Der andere Stellplatz, der dieses Kommando schon freigegeben trägt - oder null. */
    static Freigabe belegt(int nr, String kommando, List<Freigabe> alle) {
        return alle.stream().filter(f -> f.aktiv() && f.platz() != nr && f.kommando().equals(kommando)).findFirst()
                .orElse(null);
    }

    // ------------------------------------------------------------------ testen

    /**
     * Der Schalt-Test EINES Stellplatzes: ein {@code koppel_test} an die Box mit Verbindung, Soll der Kennung, Art
     * des jetzigen Angebots und Testwert. Gespeichert wird der Versuch und, nur wenn bestanden, der Beleg - beide an
     * der Form des Angebots. Die Datenbank hält keine Transaktion offen, während die Box antwortet.
     */
    public KoppelbildDto.TestErgebnis testen(UUID geraetId, int platz, KoppelbildDto.TestAnfrage anfrage,
            String subject) {
        Steuerung s = steuerung(geraetId);
        platz(platz);
        requireBoxKann(s);
        Long kennung = steuerungen.fassung(geraetId).map(AnlagensteuerungRepository.Fassung::steuerungKennung)
                .orElse(null);
        if (kennung == null) {
            throw konflikt("Ohne Steuerungskennung schreibt die Box nicht. Bitte tragen Sie die Kennung der Steuerung "
                    + "in ihrer Fassung ein.");
        }
        Koppelbild.Angebot angebot = angebot(s, platz).orElseThrow(() -> konflikt("Stellplatz " + platz
                + " bietet gerade nichts an - die Box hat dafür kein Angebot der Steuerung gemeldet."));
        Long wert = anfrage == null ? null : anfrage.wert();
        if (wert == null) {
            throw bad("Bitte geben Sie einen Testwert an.");
        }
        if (!angebot.imBand(wert)) {
            throw bad("Der Testwert " + Koppelbild.wertText(angebot.art(), wert) + " liegt außerhalb des Bands von "
                    + "Stellplatz " + platz + " (" + Koppelbild.bandText(angebot) + "). Die Box klemmt ihn nicht, "
                    + "bitte wählen Sie einen Wert im Band.");
        }
        AnlagensteuerungQuelle.Transport t = steuerungen.quelle(s.dataSourceId())
                .flatMap(q -> AnlagensteuerungQuelle.transport(q.protokoll(), q.adresse(), s.unitId()))
                .orElseThrow(() -> konflikt("Die Datenquelle der Steuerung ist für die Box nicht lesbar "
                        + "(Modbus TCP mit Adresse und Geräte-ID)."));

        ProbeResult res = probes.koppelTest(s.siteId(), s.entityId(), new ProbePublisher.KoppelTestOp(
                "stellplatz-" + platz, t.host(), t.port(), t.unitId(), kennung, platz, angebot.art(), wert,
                Koppelbild.TEST_TTL_S), subject);
        ProbeResult.OpResult line = res.results() == null || res.results().isEmpty() ? null : res.results().get(0);
        ProbeResult.KoppelTest kt = line == null ? null : line.koppelTest();
        boolean passt = kt == null || kt.angebot() == null || passt(kt.angebot(), angebot);
        boolean bestanden = res.errorCode() == null && line != null && line.ok() && kt != null && passt
                && kt.urteil() != null && Koppelbild.TEST_ANGENOMMEN.contains(kt.urteil());
        String satz = satz(res, line, kt, passt, bestanden, platz, angebot, wert);

        Instant jetzt = uhr.instant();
        boolean gefallen = Boolean.TRUE.equals(tx.execute(st -> {
            Freigabe alt = repo.freigabe(geraetId, platz).orElse(null);
            boolean faellt = alt != null && alt.aktiv() && !alt.form().equals(angebot);
            boolean gleicheForm = alt != null && alt.form().equals(angebot);
            Freigabe neu = new Freigabe(alt == null ? null : alt.id(), geraetId, s.siteId(), platz, angebot,
                    angebot.kommando(), jetzt, kt == null ? null : kt.urteil(), bestanden,
                    bestanden ? wert : gleicheForm ? alt.testWert() : null,
                    bestanden ? kt.urteil() : gleicheForm ? alt.testUrteil() : null,
                    bestanden ? kt.wirksam() : gleicheForm ? alt.testWirksam() : null,
                    bestanden ? kt.folge() : gleicheForm ? alt.testFolge() : null,
                    bestanden ? jetzt : gleicheForm ? alt.testAt() : null,
                    bestanden ? subject : gleicheForm ? alt.testVon() : null,
                    // Eine Freigabe gehört zu ihrer Form: mit einer neuen Form bleibt von ihr nur die Spur.
                    gleicheForm ? alt.freigegebenAt() : null, gleicheForm ? alt.freigegebenVon() : null,
                    gleicheForm && alt.physischBestaetigt(), gleicheForm ? alt.evidenz() : null,
                    faellt ? jetzt : alt == null ? null : alt.widerrufenAt(),
                    faellt ? SYSTEM : alt == null ? null : alt.widerrufenVon(),
                    faellt ? GRUND_ANGEBOT : alt == null ? null : alt.widerrufenGrund());
            repo.speichern(TenantContext.get(), neu);
            if (faellt) {
                audit.append(s.siteId(), s.entityId(), "switch_revoked", null, null, SYSTEM,
                        "Stellplatz " + platz + ": Freigabe entfällt, das Angebot hat sich geändert");
            }
            audit.append(s.siteId(), s.entityId(), "switch_tested", null, null, subject, "Stellplatz " + platz + ": "
                    + (bestanden ? "bestanden" : "nicht bestanden") + ", Testwert " + wert + " ("
                    + angebot.art() + "), Urteil " + (kt == null || kt.urteil() == null ? "keines" : kt.urteil())
                    + (kt == null || kt.wirksam() == null ? "" : ", wirksam " + kt.wirksam()));
            return faellt;
        }));
        if (gefallen) {
            quelle.zustellen(s.siteId());
        }
        return new KoppelbildDto.TestErgebnis(bestanden, kt, satz, res.errorCode(), bestanden);
    }

    /** Sah die Box beim Test dasselbe Angebot, auf das sich die Cloud stützt? */
    static boolean passt(ProbeResult.KoppelAngebot gesehen, Koppelbild.Angebot form) {
        return form.equals(new Koppelbild.Angebot(gesehen.art(), gesehen.ziel(), gesehen.nr(), gesehen.min(),
                gesehen.max()));
    }

    /** Der Satz zum Ergebnis eines Schalt-Tests, in Kundensprache. */
    static String satz(ProbeResult res, ProbeResult.OpResult line, ProbeResult.KoppelTest kt, boolean passt,
            boolean bestanden, int platz, Koppelbild.Angebot angebot, long wert) {
        String testwert = Koppelbild.wertText(angebot.art(), wert);
        if ("timeout".equals(res.errorCode())) {
            return "Die Box hat nicht rechtzeitig geantwortet. Ob der Testwunsch angekommen ist, ist offen; er läuft "
                    + "nach " + Koppelbild.TEST_TTL_S + " s von selbst ab.";
        }
        if (line == null || kt == null) {
            if ("not_supported".equals(line == null ? res.errorCode() : line.errorCode())) {
                return "Die Box kennt den Schalt-Test eines Stellplatzes noch nicht. Bitte aktualisieren Sie die Box.";
            }
            String m = line != null && line.message() != null ? line.message() : res.message();
            return m != null ? m : "Die Box hat den Test nicht ausgeführt.";
        }
        if (!passt) {
            return "Die Steuerung bietet auf Stellplatz " + platz + " inzwischen etwas anderes an. Bitte laden Sie die "
                    + "Ansicht neu und testen Sie erneut.";
        }
        String wirksam = kt.wirksam() == null ? "" : " Die Anlage fährt gerade "
                + Koppelbild.wertText(angebot.art(), kt.wirksam()) + ".";
        if (bestanden) {
            String kern = switch (kt.urteil()) {
                case "begrenzt" -> "Die Steuerung hat den Testwert " + testwert + " auf ihr Band begrenzt angenommen.";
                case "ueberstimmt" -> "Die Steuerung hat den Testwert " + testwert + " angenommen; eine Stelle mit "
                        + "Vorrang bestimmt gerade.";
                default -> "Die Steuerung hat den Testwert " + testwert + " angenommen.";
            };
            return kern + wirksam + " Bitte prüfen Sie die Wirkung an der Anlage, bevor Sie den Stellplatz freigeben.";
        }
        if (!Boolean.TRUE.equals(kt.geschrieben())) {
            return switch (kt.lage()) {
                case "zweiter_schreiber" -> "Die Box schreibt gerade nicht: ein zweites Programm schreibt Wünsche an "
                        + "diese Steuerung.";
                case "nicht_lesbar" -> "signatur_fremd".equals(kt.grund())
                        ? "Die Steuerung hat kein Koppelbild. Bitte lassen Sie die VoltPilot-Bibliothek einspielen."
                        : "Die Box kann die Quittung der Steuerung gerade nicht lesen.";
                case "keine_antwort" -> "Die Steuerung antwortet der Box nicht.";
                case "steuerung_fremd" -> "Unter dieser Adresse antwortet eine andere Steuerung als eingetragen.";
                case "sps_steht" -> "Das Programm der Steuerung steht.";
                case "ohne_soll" -> "Ohne Steuerungskennung schreibt die Box nicht.";
                case "gesperrt" -> "Die Anlage lässt gerade keine Fernsteuerung zu.";
                default -> "Die Box hat den Testwunsch nicht geschrieben.";
            };
        }
        if (kt.urteil() == null) {
            return "Die Box hat den Testwunsch geschrieben, die Steuerung hat ihn aber nicht rechtzeitig quittiert.";
        }
        String grund = switch (kt.urteil()) {
            case "art_fremd" -> "die Art passt nicht zum Angebot";
            case "wert_ungueltig" -> "der Wert ist ungültig";
            case "nicht_bereit" -> "der Stellplatz ist gerade nicht bereit";
            case "abgelaufen" -> "die Frist ist abgelaufen";
            case "kein_wunsch" -> "es kam kein Wunsch an";
            default -> kt.urteil();
        };
        return "Die Steuerung hat den Testwunsch nicht angenommen: " + grund + "." + wirksam;
    }

    // ------------------------------------------------------------------ freigeben

    /**
     * Die FREIGABE eines Stellplatzes: ein bestandener Test für genau das jetzige Angebot UND die Bestätigung, dass
     * die Wirkung an der Anlage gesehen wurde. Danach trägt der Registry-Push die Fähigkeit des Stellplatzes.
     */
    public KoppelbildDto.Koppelbild freigeben(UUID geraetId, int platz, KoppelbildDto.FreigabeAnfrage anfrage,
            String subject) {
        Steuerung s = steuerung(geraetId);
        platz(platz);
        requireBoxKann(s);
        Koppelbild.Angebot angebot = angebot(s, platz).orElseThrow(() -> konflikt("Stellplatz " + platz
                + " bietet gerade nichts an - ohne Angebot gibt es keine Freigabe."));
        boolean neu = Boolean.TRUE.equals(tx.execute(st -> {
            List<Freigabe> alle = repo.freigabenSperren(geraetId);
            Freigabe z = alle.stream().filter(f -> f.platz() == platz).findFirst().orElse(null);
            if (z == null || !z.beleg(angebot)) {
                throw konflikt("Bitte testen Sie Stellplatz " + platz + " zuerst - erst danach lässt er sich "
                        + "freigeben.");
            }
            if (z.aktiv()) {
                return false;
            }
            if (anfrage == null || !Boolean.TRUE.equals(anfrage.physicallyConfirmed())) {
                throw bad("Bitte bestätigen Sie, dass Sie die Wirkung an der Anlage gesehen haben.");
            }
            Freigabe anderer = belegt(platz, angebot.kommando(), alle);
            if (anderer != null) {
                throw konflikt("Die Steuerung hat für dieses Kommando schon Stellplatz " + anderer.platz()
                        + " freigegeben. Je Kommando nimmt die Box nur einen Stellplatz - bitte nehmen Sie diese "
                        + "Freigabe zuerst zurück.");
            }
            Instant jetzt = uhr.instant();
            String evidenz = "Stellplatz " + platz + " (" + angebot.art() + " " + angebot.ziel() + " " + angebot.nr()
                    + ", Band " + angebot.min() + " bis " + angebot.max() + "): Test " + z.testWert() + " "
                    + z.testUrteil() + (z.testWirksam() == null ? "" : ", wirksam " + z.testWirksam()) + " am "
                    + z.testAt() + "; Wirkung an der Anlage bestätigt";
            repo.speichern(TenantContext.get(), new Freigabe(z.id(), z.geraetId(), z.siteId(), platz, z.form(),
                    z.kommando(), z.versuchAt(), z.versuchUrteil(), z.versuchOk(), z.testWert(), z.testUrteil(),
                    z.testWirksam(), z.testFolge(), z.testAt(), z.testVon(), jetzt, subject, true, evidenz, null,
                    null, null));
            audit.append(s.siteId(), s.entityId(), "switch_released", null, null, subject, evidenz);
            return true;
        }));
        if (neu) {
            quelle.zustellen(s.siteId());
        }
        return koppelbild(s);
    }

    /** Nimmt die Freigabe eines Stellplatzes zurück; die Box schreibt dort keinen Wunsch mehr. Idempotent. */
    public KoppelbildDto.Koppelbild zuruecknehmen(UUID geraetId, int platz, String subject) {
        Steuerung s = steuerung(geraetId);
        platz(platz);
        boolean widerrufen = Boolean.TRUE.equals(tx.execute(st -> {
            Freigabe z = repo.freigabe(geraetId, platz).orElse(null);
            if (z == null || !repo.widerrufen(z.id(), uhr.instant(), subject, GRUND_ZURUECKGENOMMEN)) {
                return false;
            }
            audit.append(s.siteId(), s.entityId(), "switch_revoked", null, null, subject, "Stellplatz " + platz);
            return true;
        }));
        if (widerrufen) {
            quelle.zustellen(s.siteId());
        }
        return koppelbild(s);
    }

    // ------------------------------------------------------------------ Abgleich mit dem Herzschlag

    /**
     * Lässt jede geltende Freigabe der Steuerung fallen, deren Angebot der neue Stand anders meldet (Form geändert
     * oder weg). Im Kontext des Aufrufers (Mandant gesetzt, seine Transaktion); {@code true}, wenn eine fiel - der
     * Aufrufer stellt dann den Push zu.
     */
    public boolean abgleichen(UUID geraetId, UUID siteId, UUID entityId, Koppelbild.Stand stand) {
        boolean gefallen = false;
        for (Freigabe f : repo.freigaben(geraetId)) {
            if (!f.aktiv() || !Koppelbild.angebotGeaendert(stand, f.platz(), f.form())) {
                continue;
            }
            if (repo.widerrufen(f.id(), uhr.instant(), SYSTEM, GRUND_ANGEBOT)) {
                Koppelbild.Angebot jetzt = stand.angebot(f.platz());
                audit.append(siteId, entityId, "switch_revoked", null, null, SYSTEM, "Stellplatz " + f.platz()
                        + ": Freigabe entfällt, die Steuerung meldet "
                        + (jetzt == null ? "kein Angebot mehr" : "ein anderes Angebot (" + jetzt.art() + " "
                                + jetzt.ziel() + " " + jetzt.nr() + ", Band " + jetzt.min() + " bis " + jetzt.max()
                                + ")"));
                log.info("Koppelbild: Freigabe Stellplatz {} der Steuerung {} entfällt (Angebot geändert)", f.platz(),
                        geraetId);
                gefallen = true;
            }
        }
        return gefallen;
    }

    // ------------------------------------------------------------------ Hilfen

    /** Ob die Box, die die Steuerung gerade liest, das Koppelbild kann. */
    boolean boxKann(Steuerung s) {
        UUID box = s.dataSourceId() == null ? null : steuerungen.leser(s.dataSourceId()).orElse(null);
        return box != null && faehigkeiten.kann(box, Koppelbild.FAEHIGKEIT);
    }

    private void requireBoxKann(Steuerung s) {
        if (!boxKann(s)) {
            throw konflikt("Die Box, die diese Steuerung liest, kann das Koppelbild noch nicht (Fähigkeit "
                    + Koppelbild.FAEHIGKEIT + " fehlt). Bitte erst die Box aktualisieren.");
        }
    }

    /** Das jetzige Angebot eines Stellplatzes aus dem jüngsten Stand. */
    private Optional<Koppelbild.Angebot> angebot(Steuerung s, int platz) {
        return repo.juengsterStand(s.entityId()).map(z -> Koppelbild.stand(lies(z.json())))
                .map(st -> st.angebot(platz));
    }

    private Steuerung steuerung(UUID geraetId) {
        return steuerungen.steuerung(geraetId).orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
    }

    private static void platz(int platz) {
        if (platz < 1 || platz > Koppelbild.PLAETZE) {
            throw bad("Ein Stellplatz hat die Nummer 1 bis " + Koppelbild.PLAETZE + ".");
        }
    }

    private com.fasterxml.jackson.databind.JsonNode lies(String text) {
        try {
            return json.readTree(Objects.requireNonNull(text));
        } catch (Exception e) {
            return null;
        }
    }

    static java.time.OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static ResponseStatusException nichtGefunden(String grund) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, grund);
    }

    private static ResponseStatusException konflikt(String grund) {
        return new ResponseStatusException(HttpStatus.CONFLICT, grund);
    }

    private static ResponseStatusException bad(String grund) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, grund);
    }
}
