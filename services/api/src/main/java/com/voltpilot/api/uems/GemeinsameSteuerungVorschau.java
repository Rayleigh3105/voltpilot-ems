package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.web.dto.GemeinsameSteuerungEinrichtenDto;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.interceptor.TransactionAspectSupport;

/**
 * Frage 6 für einen ENTWURF (UEMS AP-15, §5.2 Nr. 6/7): das Ergebnis der Folge, bevor „Absenden“ schreibt. Die
 * Vorschau nimmt denselben Körper wie {@code PUT …/gemeinsame-steuerung}, spielt genau dieses Einrichten in EINER
 * Transaktion durch ({@link GemeinsameSteuerungService#einrichten} — dieselben Prüfungen, dieselben 400/409/422) und
 * liest danach, was {@code GET …/einrichten} läse ({@link GemeinsameSteuerungErklaerung#lesen}, Ergebnis aus
 * {@code SteuerungsverbundAnteilDienst#ableiten}), dazu den Zustand, den das {@code PUT} antworten würde ({@code fehlt}
 * trägt die Sätze von Frage 6 wie „braucht ein Update“). Die Transaktion wird IMMER zurückgerollt: keine Zeile, kein
 * Protokoll, keine Stufe, kein entwerteter Nachweis — eine Anlage ohne Gemeinsame Steuerung bleibt ohne (I6).
 *
 * <p>Nur die Datenbank wird angefasst: das Einrichten sendet nichts an die Boxen (das tun erst Scharfschalten und
 * Ausrollen des Betreibers), und was nach dem Commit liefe, läuft nach einem Rollback nie.
 */
@Service
public class GemeinsameSteuerungVorschau {

    private final GemeinsameSteuerungService dienst;
    private final GemeinsameSteuerungErklaerung erklaerung;

    public GemeinsameSteuerungVorschau(GemeinsameSteuerungService dienst, GemeinsameSteuerungErklaerung erklaerung) {
        this.dienst = dienst;
        this.erklaerung = erklaerung;
    }

    /** Das Bild von {@code GET …/einrichten} und der Zustand für den Entwurf — geschrieben wird nichts. */
    @Transactional
    public GemeinsameSteuerungEinrichtenDto.Vorschau vorschau(UUID siteId,
            List<GemeinsameSteuerungDto.MitgliedWunsch> mitglieder, GemeinsameSteuerungErklaerung.Wunsch wunsch,
            ProtokollAkteur wer) {
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
        GemeinsameSteuerungDto.Zustand zustand = dienst.einrichten(siteId, mitglieder, wunsch, wer);
        return new GemeinsameSteuerungEinrichtenDto.Vorschau(erklaerung.lesen(siteId), zustand);
    }
}
