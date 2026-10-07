package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementMappeDto;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Filter;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Gruppe;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Verzeichnis;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Zeile;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * „Unterlagen zusammenstellen“ (Konzept Nachweisen n1, Runde 2, Entscheid 7): die Mappe für eine Prüfung von außen.
 * Sie liest das Verzeichnis ({@link EnergiemanagementVerzeichnisService}, im Zaun und mit den Rechten des Aufrufers) und
 * macht daraus zwei Dateien: ein PDF mit Inhaltsverzeichnis ({@link MappePdf}) und die Verzeichnis-CSV des Zeitraums.
 * Beide werden mit Prüfsumme festgehalten und sind 30 Tage abrufbar; jeder Abruf wird protokolliert.
 *
 * <p>Was hineingeht: „Was am Stichtag gilt“ - je Dokument die jüngste freigegebene Fassung, die laufenden Aufgaben und
 * die geltenden Vermerke „trifft zurzeit nicht zu“ der gewählten Gruppen, auch wenn sie vor dem Zeitraum entschieden
 * wurden; und „Was im Zeitraum festgehalten wurde“ - jede Zeile des Verzeichnisses der gewählten Gruppen mit ihrem
 * Tag im Zeitraum. Dazu die Teile, die das Portal beim Zusammenstellen als offen zeigte (Entscheid 4: der Stand je Teil
 * lebt im Portal); sie stehen als offen in der Mappe, ohne Urteil.
 *
 * <p>Rechte: Anlegen {@code energiemanagement.verwalten} am Unternehmen (am Controller); lesen und abrufen, wer
 * unternehmensweit liest (Zaun {@code site_scope}) - also auch „Einsicht“, für die eine Mappe meist gedacht ist.
 */
@Service
public class EnergiemanagementMappeService {

    static final List<String> ANLAESSE = EnergiemanagementRegeln.VOKABULARE.get("mappe_anlass");
    static final List<String> GRUPPEN = EnergiemanagementRegeln.VOKABULARE.get("verzeichnis_gruppe");
    static final List<String> TEILE = EnergiemanagementRegeln.VOKABULARE.get("teil");
    private static final List<String> DOKUMENT_ARTEN = EnergiemanagementRegeln.VOKABULARE.get("dokument_art");
    /** Entscheid 7: so lange sind die Dateien einer Mappe abrufbar. */
    static final int AUFBEWAHRUNG_TAGE = 30;
    /** Was am Stichtag gilt, ohne ein Dokument zu sein: laufende Aufgaben und geltende Vermerke. */
    private static final Set<String> STAND_ARTEN = Set.of("aufgabe", "teil_vermerk");
    private static final String AUFGEHOBEN = " · aufgehoben am ";

    private static final Map<String, String> TITEL = Map.of("audit_von_aussen", "Unterlagen für das Audit",
            "anfrage_behoerde", "Unterlagen für die Behörde", "eigene_ablage", "Unterlagen für die eigene Ablage");
    private static final DateTimeFormatter DATEI_TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    public record Anfrage(String anlass, String von, List<String> gruppen, List<String> offen) {}

    public record Datei(String name, String typ, byte[] inhalt) {}

    private final EnergiemanagementMappeRepository repo;
    private final EnergiemanagementVerzeichnisService verzeichnis;
    private final UnternehmenRepository unternehmen;
    private final RechtPruefung rechte;
    private final TransactionTemplate tx;

    public EnergiemanagementMappeService(EnergiemanagementMappeRepository repo,
            EnergiemanagementVerzeichnisService verzeichnis, UnternehmenRepository unternehmen, RechtPruefung rechte,
            PlatformTransactionManager tm) {
        this.repo = repo;
        this.verzeichnis = verzeichnis;
        this.unternehmen = unternehmen;
        this.rechte = rechte;
        this.tx = new TransactionTemplate(tm);
    }

    /**
     * Stellt eine Mappe zusammen. 400 bei unbekanntem Anlass, unbekannter Gruppe oder unbekanntem Teil, ohne Gruppe,
     * mit einem {@code von} nach dem Stichtag; der Stichtag ist der des Verzeichnisses (die Uhr der Route).
     */
    public EnergiemanagementMappeDto.Mappe erstellen(Anfrage a, ProtokollAkteur wer) {
        if (a == null || a.anlass() == null || !ANLAESSE.contains(a.anlass())) {
            throw EnergiemanagementAbgelehnt.anfrage("anlass");
        }
        List<String> gruppen = eindeutig(a.gruppen());
        if (gruppen.isEmpty() || !GRUPPEN.containsAll(gruppen)) {
            throw EnergiemanagementAbgelehnt.anfrage("gruppen");
        }
        List<String> offen = eindeutig(a.offen());
        if (!TEILE.containsAll(offen)) {
            throw EnergiemanagementAbgelehnt.anfrage("offen");
        }
        offen = TEILE.stream().filter(offen::contains).toList();
        gruppen = GRUPPEN.stream().filter(gruppen::contains).toList();

        Verzeichnis alle = verzeichnis.lesen(null, null, null, null);
        LocalDate bis = alle.stichtag().toLocalDate();
        LocalDate von = tag(a.von());
        if (von != null && von.isAfter(bis)) {
            throw EnergiemanagementAbgelehnt.anfrage("von");
        }
        List<Gruppe> gilt = new ArrayList<>();
        List<Gruppe> imZeitraum = new ArrayList<>();
        for (Gruppe g : alle.gruppen()) {
            if (!gruppen.contains(g.gruppe())) continue;
            List<Zeile> stand = gilt(g.zeilen());
            if (!stand.isEmpty()) gilt.add(new Gruppe(g.gruppe(), g.gruppeWort(), g.zuschnitt(), null, stand));
            List<Zeile> zeitraum = g.zeilen().stream()
                    .filter(z -> z.tag() != null && (von == null || !z.tag().isBefore(von)) && !z.tag().isAfter(bis))
                    .sorted(Comparator.comparing(Zeile::tag).thenComparing(z -> String.valueOf(z.kennzeichen())))
                    .toList();
            imZeitraum.add(new Gruppe(g.gruppe(), g.gruppeWort(), g.zuschnitt(), null, zeitraum));
        }
        int eintraege = imZeitraum.stream().mapToInt(g -> g.zeilen().size()).sum();
        int gelten = gilt.stream().mapToInt(g -> g.zeilen().size()).sum();

        String titel = TITEL.get(a.anlass());
        String anlassWort = EnergiemanagementRegeln.WOERTER.get("mappe_anlass").get(a.anlass());
        String dateiTitel = dateiTitel(bis);
        byte[] csv = csv(new Verzeichnis(alle.stichtag(), alle.verantwortung(), new Filter(null, von, bis, null, null),
                imZeitraum), titel, anlassWort, wer);
        String csvSha = sha256(csv);
        List<String> offenWoerter = offen.stream().map(t -> EnergiemanagementRegeln.WOERTER.get("teil").get(t)).toList();
        byte[] pdf = MappePdf.datei(new MappePdf.Inhalt(titel, dateiTitel, anlassWort, von, bis, alle.stichtag(),
                wer.name(), gilt, imZeitraum, offenWoerter, csvSha));
        List<String> g = gruppen;
        List<String> o = offen;
        UUID id = tx.execute(s -> {
            repo.abgelaufeneLeeren();
            return repo.anlegen(a.anlass(), von, bis, g, o, alle.stichtag().toInstant(), eintraege, gelten, pdf,
                    sha256(pdf), csv, csvSha, AUFBEWAHRUNG_TAGE, wer);
        });
        return mappe(id);
    }

    /** Alle Mappen, die jüngste zuerst; wer nicht unternehmensweit liest, bekommt keine, ohne Hinweis. */
    public EnergiemanagementMappeDto.Mappen mappen() {
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN, null)) {
            return new EnergiemanagementMappeDto.Mappen(List.of());
        }
        tx.executeWithoutResult(s -> repo.abgelaufeneLeeren());
        return new EnergiemanagementMappeDto.Mappen(repo.mappen().stream().map(this::dto).toList());
    }

    public EnergiemanagementMappeDto.Mappe mappe(UUID id) {
        if (!rechte.lesbar(RechtZiel.UNTERNEHMEN, null)) {
            throw mappeFehlt();
        }
        return dto(repo.mappe(id).orElseThrow(EnergiemanagementMappeService::mappeFehlt));
    }

    /**
     * Eine Datei der Mappe ({@code pdf} oder {@code csv}): erst die Datei, dann der Abruf im Protokoll, in einer
     * Transaktion - scheitert das Protokoll, verlässt keine Datei den Server. Nach der Frist 410 {@code mappe_abgelaufen}.
     */
    public Datei datei(UUID id, String format, ProtokollAkteur wer) {
        if (!"pdf".equals(format) && !"csv".equals(format)) {
            throw EnergiemanagementAbgelehnt.anfrage("format");
        }
        var m = repo.mappe(id).filter(x -> rechte.lesbar(RechtZiel.UNTERNEHMEN, null))
                .orElseThrow(EnergiemanagementMappeService::mappeFehlt);
        return tx.execute(s -> {
            var d = repo.dateien(id).orElseThrow(EnergiemanagementMappeService::abgelaufen);
            repo.abruf(id, format, wer);
            String name = dateiName(m.bis()) + "." + format;
            return "pdf".equals(format) ? new Datei(name, "application/pdf", d.pdf())
                    : new Datei(name, "text/csv;charset=UTF-8", d.csv());
        });
    }

    static EnergiemanagementAbgelehnt mappeFehlt() {
        return new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Mappe gibt es nicht.", null);
    }

    static EnergiemanagementAbgelehnt abgelaufen() {
        return new EnergiemanagementAbgelehnt(410, "mappe_abgelaufen", "Die Mappe war " + AUFBEWAHRUNG_TAGE
                + " Tage abrufbar und ist es nicht mehr. Stellen Sie die Unterlagen neu zusammen.", null);
    }

    /**
     * Was am Stichtag gilt: je Dokument (Kennzeichen) die Fassung mit der höchsten Nummer, dazu laufende Aufgaben und
     * geltende Vermerke. Bekanntmachungen und andere Ereignisse gehören in den Zeitraum.
     */
    static List<Zeile> gilt(List<Zeile> zeilen) {
        Map<String, Zeile> juengste = new LinkedHashMap<>();
        List<Zeile> stand = new ArrayList<>();
        for (Zeile z : zeilen) {
            if (DOKUMENT_ARTEN.contains(z.art()) && z.kennzeichen() != null && z.nr() != null) {
                juengste.merge(z.kennzeichen(), z, (alt, neu) -> neu.nr() > alt.nr() ? neu : alt);
            } else if (STAND_ARTEN.contains(z.art()) && !z.titel().contains(AUFGEHOBEN)) {
                // Ein aufgehobener Vermerk bleibt im Verzeichnis eine Entscheidung (Titel „· aufgehoben am …“), gilt aber nicht.
                stand.add(z);
            }
        }
        List<Zeile> raus = new ArrayList<>(juengste.values());
        raus.addAll(stand);
        return raus;
    }

    private EnergiemanagementMappeDto.Mappe dto(EnergiemanagementMappeRepository.Mappe m) {
        return new EnergiemanagementMappeDto.Mappe(m.id(), TITEL.get(m.anlass()), m.anlass(),
                EnergiemanagementRegeln.WOERTER.get("mappe_anlass").get(m.anlass()), m.von(), m.bis(),
                m.stichtag().atZone(zone()).toOffsetDateTime(), m.gruppen(),
                m.gruppen().stream().map(x -> EnergiemanagementRegeln.WOERTER.get("verzeichnis_gruppe").get(x)).toList(),
                m.offen(), m.offen().stream().map(x -> EnergiemanagementRegeln.WOERTER.get("teil").get(x)).toList(),
                m.eintraege(), m.gilt(), dateiTitel(m.bis()), dateiName(m.bis()), m.pdfSha256(), m.csvSha256(),
                m.abrufbar(), m.abrufbar() ? m.abrufbarTage() : 0, AUFBEWAHRUNG_TAGE, repo.abrufe(m.id()),
                new EnergiemanagementMappeDto.Erstellt(m.akteur().name(), m.angelegtAm()), verzeichnis.jetzt());
    }

    private java.time.ZoneId zone() {
        return java.time.ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
    }

    /** „Nachweise Ahrenberg, 30.04.2029“ - mit dem Kurznamen des Unternehmens, sonst seinem Namen. */
    private String dateiTitel(LocalDate bis) {
        String name = unternehmen.desKundenbereichs().map(u -> u.kurzname() != null && !u.kurzname().isBlank()
                ? u.kurzname() : u.name()).orElse("");
        return ("Nachweise " + name).strip() + ", " + bis.format(DATEI_TAG);
    }

    /** „nachweise-2029-04-30“ - der Dateiname ohne Endung, nur ASCII. */
    private static String dateiName(LocalDate bis) {
        return "nachweise-" + bis;
    }

    /** Die Verzeichnis-CSV des Zeitraums mit einer ersten Zeile, die sagt, wofür und von wem. */
    private static byte[] csv(Verzeichnis v, String titel, String anlass, ProtokollAkteur wer) {
        String csv = new String(EnergiemanagementVerzeichnisService.csv(v), StandardCharsets.UTF_8);
        String kopf = "# " + titel + " (" + anlass + "), zusammengestellt von " + wer.name() + "\r\n";
        // Die Datei beginnt mit der BOM; die Kopfzeile steht dahinter.
        return (csv.charAt(0) == '﻿' ? "﻿" + kopf + csv.substring(1) : kopf + csv).getBytes(StandardCharsets.UTF_8);
    }

    private static List<String> eindeutig(List<String> werte) {
        if (werte == null) return List.of();
        if (werte.stream().anyMatch(w -> w == null)) throw EnergiemanagementAbgelehnt.anfrage("");
        return new ArrayList<>(new LinkedHashSet<>(werte));
    }

    private static LocalDate tag(String wert) {
        if (wert == null || wert.isBlank()) return null;
        try {
            return LocalDate.parse(wert.strip());
        } catch (DateTimeParseException e) {
            throw EnergiemanagementAbgelehnt.anfrage("von");
        }
    }

    static String sha256(byte[] daten) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(daten));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 fehlt in dieser JVM", e);
        }
    }
}
