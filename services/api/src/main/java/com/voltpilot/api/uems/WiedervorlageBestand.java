package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.core.annotation.Order;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-21 (WV1, WV2, W9, Z1): die Wiedervorlage-Quelle „Bestand“ — die Fristen, die AP-12 bis AP-18 schon
 * beim Abruf ableiten, gelesen über die Leser ihrer Dienste (Zaun und Rechte des Aufrufers). Nachgerechnet wird nichts:
 *
 * <ul>
 *   <li>AP-16 S5: die Überprüfung der energetischen Bewertung — {@link BewertungFrist} an der Berichts-Liste;
 *   <li>AP-12 E7: je offener Revisions-Anstoß eines Berichts eine Zeile ab dem Tag, an dem er erkannt wurde;
 *   <li>AP-17 F5: die Überprüfung jeder laufenden Bezugsbasis — die {@code frist} der Basis-Antwort;
 *   <li>AP-18 F1–F3 (W9): die fälligen Vorgänge aus {@code faellig[]} des Übersichts-Lesers ({@link
 *       VerbesserungUebersicht}); noch nicht fällige offene Vorgänge mit dem Termin aus ihrem Register (die Vorschau
 *       — der Übersichts-Leser nennt nur fällige);
 *   <li>Messbedarf (Z1): der Übersichts-Leser zählt ihn nur — hier je offener Bedarf mit Frist eine Zeile, der Tag über
 *       dieselbe Regel {@link VerbesserungRegeln#frist} (Art {@code abweichung}) wie dort.
 * </ul>
 */
@Component
@Order(50)
public class WiedervorlageBestand implements WiedervorlageQuelle {

    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final Map<String, String> AP18_ART = Map.of("massnahme", "massnahme_termin", "abweichung",
            "abweichung_frist", "energieziel", "energieziel_bewertung");

    private final BerichtService berichte;
    private final KennzahlService kennzahlen;
    private final BezugsbasisService bezugsbasen;
    private final VerbesserungUebersicht uebersicht;
    private final MassnahmeService massnahmen;
    private final EnergiezielService energieziele;
    private final AbweichungService abweichungen;
    private final MessbedarfService messbedarfe;
    private final UnternehmenRepository unternehmen;

    public WiedervorlageBestand(BerichtService berichte, KennzahlService kennzahlen, BezugsbasisService bezugsbasen,
            VerbesserungUebersicht uebersicht, MassnahmeService massnahmen, EnergiezielService energieziele,
            AbweichungService abweichungen, MessbedarfService messbedarfe, UnternehmenRepository unternehmen) {
        this.berichte = berichte;
        this.kennzahlen = kennzahlen;
        this.bezugsbasen = bezugsbasen;
        this.uebersicht = uebersicht;
        this.massnahmen = massnahmen;
        this.energieziele = energieziele;
        this.abweichungen = abweichungen;
        this.messbedarfe = messbedarfe;
        this.unternehmen = unternehmen;
    }

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        ZoneId zone = ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone)
                .orElse("Europe/Berlin"));
        var aus = new ArrayList<Frist>();
        berichte(aus, zone);
        bezugsbasen(aus, zone);
        verbesserung(aus, abruf);
        messbedarfe(aus, abruf);
        return aus;
    }

    // ------------------------------------------------------------------ AP-12, AP-16

    private void berichte(List<Frist> aus, ZoneId zone) {
        var wer = ProtokollAkteur.aus(SecurityContextHolder.getContext().getAuthentication()).orElse(null);
        if (wer == null) return;
        List<BerichtService.Uebersicht> liste;
        try {
            liste = berichte.liste(wer);
        } catch (BerichtAbgelehnt keinBericht) {
            return; // Der Aufrufer liest nirgends einen Bericht — die Wiedervorlage nennt ihm keinen.
        }
        for (var u : liste) {
            var kopf = u.kopf();
            var pruefung = u.ueberpruefung();
            if (pruefung != null && pruefung.frist() != null && pruefung.frist().faelligAm() != null) {
                aus.add(new Frist("bewertung_ueberpruefung", kopf.kennung(), "Energetische Bewertung — Überprüfung",
                        pruefung.frist().faelligAm(), null, null, null));
            }
            if (!BerichtService.ZEICHEN_REVISION.equals(u.standZeichen())) continue;
            for (var a : berichte.detail(kopf.kennung(), wer).anstoesse()) {
                if (!BerichtService.OFFEN.equals(a.zustand())) continue;
                aus.add(new Frist("bericht_anstoss", kopf.kennung(), kopf.geltungName() + " · " + kopf.schluessel()
                        + " — Revision angestoßen (" + a.anlassKennung() + ")", tag(a.erkanntAm(), zone), null, null,
                        null));
            }
        }
    }

    // ------------------------------------------------------------------ AP-17

    private void bezugsbasen(List<Frist> aus, ZoneId zone) {
        for (var k : kennzahlen.liste().kennzahlen()) {
            for (var b : bezugsbasen.liste(k.id()).bezugsbasen()) {
                BezugsbasisDto.Frist f = b.frist();
                // Die laufende Fassung: die jüngste freigegebene ohne „gilt bis“ — an ihr hängt die Frist (F5).
                Integer nr = b.fassungen().stream()
                        .filter(x -> "freigegeben".equals(x.freigabeStatus()) && x.giltBis() == null)
                        .map(BezugsbasisDto.FassungKurz::fassung).max(Integer::compare).orElse(null);
                if (f == null || nr == null) continue;
                LocalDate freigabe = tag(bezugsbasen.fassung(k.id(), b.id(), nr).freigegebenAm(), zone);
                String beginn = f.bestaetigtAm() != null && (freigabe == null || f.bestaetigtAm().isAfter(freigabe))
                        ? "geprüft, bleibt " + TAG.format(f.bestaetigtAm())
                        : "Freigabe " + (freigabe == null ? "" : TAG.format(freigabe));
                aus.add(new Frist("bezugsbasis_ueberpruefung", b.kennzeichen(), "Bezugsbasis " + b.kennzeichen()
                        + ", Fassung " + nr + " — Überprüfung (" + beginn + " + " + f.wiedervorlageMonate() + " Monate)",
                        f.faelligAm(), b.verantwortlichName(), b.id(), k.id()));
            }
        }
    }

    // ------------------------------------------------------------------ AP-18

    private void verbesserung(List<Frist> aus, LocalDate abruf) {
        Set<UUID> faellig = new HashSet<>();
        for (var z : uebersicht.lesen().faellig()) {
            faellig.add(z.id());
            aus.add(new Frist(AP18_ART.get(z.art()), z.kennzeichen(), z.titel(), z.termin(), z.verantwortlich(), z.id(),
                    z.kennzahlId()));
        }
        // Vorschau: offen und noch nicht fällig — der Termin steht im Register (F2), die Wiedervorlage rechnet ihn nicht.
        for (var m : massnahmen.liste(List.of(), "geplant", null, null, null).massnahmen()) {
            if (faellig.contains(m.id()) || m.frist() == null || m.frist().faellig() != null) continue;
            aus.add(new Frist("massnahme_termin", m.kennzeichen(), m.titel(), m.frist().termin(),
                    m.verantwortlich() == null ? null : m.verantwortlich().name(), m.id(),
                    m.messgrundlage() == null ? null : m.messgrundlage().kennzahl().id()));
        }
        for (var a : abweichungen.liste(List.of(), "offen", null, null).abweichungen()) {
            if (faellig.contains(a.id()) || a.frist() == null || a.frist().faellig() != null) continue;
            aus.add(new Frist("abweichung_frist", a.kennzeichen(), a.kennzahl().kennzeichen() + " " + a.kennzahl().name(),
                    a.frist().termin(), a.verantwortlich() == null ? null : a.verantwortlich().name(), a.id(),
                    a.kennzahl().id()));
        }
        // Ein Energieziel: die Bewertung wird erst mit dem endgültigen letzten Monat fällig (F1) — bis zum Ende der
        // Zielperiode steht es in der Vorschau, danach erst wieder, wenn der Übersichts-Leser es fällig nennt.
        for (var z : energieziele.liste(List.of(), null, "offen").energieziele()) {
            if (faellig.contains(z.id()) || z.frist() == null || z.frist().faellig() != null
                    || !z.frist().termin().isAfter(abruf) || kennzahlen.lesbareKennzahlOderNichts(z.kennzahl().id()) == null) {
                continue;
            }
            aus.add(new Frist("energieziel_bewertung", z.kennzeichen(), z.wortlaut(), z.frist().termin(),
                    z.verantwortlich() == null ? null : z.verantwortlich().name(), z.id(), z.kennzahl().id()));
        }
    }

    // ------------------------------------------------------------------ AP-16 Messbedarf (Z1)

    private void messbedarfe(List<Frist> aus, LocalDate abruf) {
        for (var b : messbedarfe.alle(null).messbedarfe()) {
            if (b.frist() == null || !"offen".equals(b.zustand())) continue;
            Map<String, Object> f = VerbesserungRegeln.frist(new VerbesserungRegeln.FristEingang("abweichung",
                    b.zustand(), b.frist().toString(), null, null, abruf.toString()));
            aus.add(new Frist("messbedarf_frist", b.kennzeichen(), "Messbedarf " + b.kennzeichen() + " — Frist",
                    LocalDate.parse((String) f.get("termin")), null, b.id(), null));
        }
    }

    private static LocalDate tag(Instant am, ZoneId zone) {
        return am == null ? null : am.atZone(zone).toLocalDate();
    }

    private static LocalDate tag(OffsetDateTime am, ZoneId zone) {
        return am == null ? null : am.atZoneSameInstant(zone).toLocalDate();
    }
}
