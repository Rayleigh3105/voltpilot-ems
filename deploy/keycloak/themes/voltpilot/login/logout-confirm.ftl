<#--
  Abmelde-Bestaetigung. Erreichbar, wenn der Logout ohne id_token_hint kommt
  (z. B. ueber ein Lesezeichen).
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
<!-- template: logout-confirm.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("vpLogoutTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpLogoutHint")}</p>
    <#elseif section = "form">
        <form id="kc-logout-confirm" class="vpl-form" action="${url.logoutConfirmAction}" method="POST">
            <input type="hidden" name="session_code" value="${logoutConfirm.code}">
            <button type="submit" class="vpl-submit" name="confirmLogout" id="kc-logout"
                    data-vp-busy="${msg("vpLoggingOut")}">
                <span class="vpl-spin" hidden aria-hidden="true"></span>
                <span class="vpl-submit-label">${msg("doLogout")}</span>
            </button>
        </form>
        <#if !logoutConfirm.skipLink && (client.baseUrl)?has_content>
            <a class="vpl-secondary" href="${client.baseUrl}">${msg("vpStaySignedIn")}</a>
        </#if>
    </#if>
</@layout.registrationLayout>
