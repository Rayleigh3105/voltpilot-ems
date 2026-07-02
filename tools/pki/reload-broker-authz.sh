#!/usr/bin/env sh
# Reload the EMQX file-authorizer rules from acl.conf WITHOUT restarting the
# broker - run this after grants changed (voltpilot-ca.sh issue/revoke, or the
# api's enrollment issuance/unclaim) to make them effective.
#
# Why not `emqx ctl conf reload`: that reloads etc/emqx.conf overrides, but the
# file authorization source compiles its rules once at source init and is only
# re-initialized when its CONFIG changes - a changed acl.conf is not a config
# change, so `conf reload` (and `authz cache-clean`) provably leave the old
# rules active (verified live on EMQX 5.8.3). Re-applying the same source
# config through emqx_authz:update/2 forces the re-init that re-reads the file.
#
# Usage:
#   tools/pki/reload-broker-authz.sh                      # docker compose prod stack
#   EMQX_EXEC="docker exec my-emqx" tools/pki/reload-broker-authz.sh
#   EMQX_EXEC="" ACL_PATH=/etc/emqx/acl/acl.conf tools/pki/reload-broker-authz.sh  # on the broker host itself
set -eu

# How to reach the emqx binary; the default targets the production compose
# service - in a git clone the stack file is docker-compose.prod.yml, in the
# CI deploy dir (/srv/docker/voltpilot) it is shipped as docker-compose.yml.
if [ -z "${EMQX_EXEC+set}" ]; then
  if [ -f docker-compose.prod.yml ]; then
    EMQX_EXEC="docker compose -f docker-compose.prod.yml exec -T emqx"
  else
    EMQX_EXEC="docker compose exec -T emqx"
  fi
fi
# The acl.conf path AS THE BROKER SEES IT (the container path, not the host's).
ACL_PATH="${ACL_PATH:-/opt/emqx/etc/acl/acl.conf}"

$EMQX_EXEC emqx eval "emqx_authz:update({replace, file}, #{<<\"type\">> => <<\"file\">>, <<\"enable\">> => true, <<\"path\">> => <<\"${ACL_PATH}\">>})." >/dev/null
echo "EMQX file-authorizer rules reloaded from ${ACL_PATH}"
