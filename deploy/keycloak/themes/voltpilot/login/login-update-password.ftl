<#--
  Passwort aendern (Required Action UPDATE_PASSWORD). AKTIV erreichbar: der
  Support setzt ein Passwort mit "temporaer" zurueck, weil es ohne SMTP keine
  Selbstbedienung gibt - danach landet der Kunde hier.

  Das ist die Seite, die im Ist-Zustand am haerteste brach: sie erbte
  ungestylt von keycloak.v2 und kippte unter OS-Dunkelmodus in eine dunkle
  PatternFly-Palette (Alert 2,1:1, Checkbox-Beschriftung 1,3:1).
-->
<#import "template.ftl" as layout>
<#import "password-commons.ftl" as passwordCommons>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>
<!-- template: login-update-password.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("updatePasswordTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpUpdatePasswordHint")}</p>
    <#elseif section = "form">
        <form id="kc-passwd-update-form" class="vpl-form" action="${url.loginAction}" method="post" novalidate="novalidate">
            <#-- Umschalter NACH dem Feld - siehe die Tab-Reihenfolge-Notiz in login.ftl. -->
            <div class="vpl-field has-toggle">
                <label class="vpl-label" for="password-new">${msg("passwordNew")}</label>
                <input class="vpl-input" id="password-new" name="password-new" type="password"
                       autocomplete="new-password" autofocus
                       aria-invalid="${messagesPerField.existsError('password')?string('true','false')}"
                       <#if messagesPerField.existsError('password')>aria-describedby="vp-pw-error"</#if> />
                <button type="button" class="vpl-toggle" data-vp-toggle="password-new"
                        data-vp-show="${msg("vpShow")}" data-vp-hide="${msg("vpHide")}"
                        aria-controls="password-new" aria-pressed="false">${msg("vpShow")}</button>
                <#if messagesPerField.existsError('password')>
                    <p class="vpl-error" id="vp-pw-error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                        <span>${kcSanitize(messagesPerField.get('password'))?no_esc}</span>
                    </p>
                </#if>
            </div>

            <div class="vpl-field">
                <label class="vpl-label" for="password-confirm">${msg("passwordConfirm")}</label>
                <input class="vpl-input" id="password-confirm" name="password-confirm" type="password"
                       autocomplete="new-password"
                       aria-invalid="${messagesPerField.existsError('password-confirm')?string('true','false')}"
                       <#if messagesPerField.existsError('password-confirm')>aria-describedby="vp-pw2-error"</#if> />
                <#if messagesPerField.existsError('password-confirm')>
                    <p class="vpl-error" id="vp-pw2-error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                        <span>${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}</span>
                    </p>
                </#if>
            </div>

            <@passwordCommons.logoutOtherSessions/>

            <button type="submit" class="vpl-submit" data-vp-busy="${msg("vpSaving")}">
                <span class="vpl-spin" hidden aria-hidden="true"></span>
                <span class="vpl-submit-label">${msg("vpSavePassword")}</span>
            </button>
            <#if isAppInitiatedAction??>
                <button type="submit" name="cancel-aia" value="true" class="vpl-secondary">${msg("doCancel")}</button>
            </#if>
        </form>
    </#if>
</@layout.registrationLayout>
