#!/usr/bin/env bash
# Import a base64 PKCS#12 into an ephemeral GitHub-hosted macOS runner.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${CSC_LINK:?}" "${CSC_KEY_PASSWORD:?}" "${APPLE_TEAM_ID:?}"
keychain="$RUNNER_TEMP/kladje-signing.keychain-db"
p12=$(mktemp "$RUNNER_TEMP/kladje-cert.XXXXXXXX")
trap 'rm -f "$p12"' EXIT

# Accept a base64 string or a base64 data URI. Keep the material out of logs.
case "$CSC_LINK" in
  data:*\;base64,*) encoded=${CSC_LINK#*,} ;;
  *://*) echo "::error::CSC_LINK must contain a base64 PKCS#12 certificate for this workflow"; exit 1 ;;
  *) encoded=$CSC_LINK ;;
esac
printf '%s' "$encoded" | base64 -D > "$p12"
unset encoded CSC_LINK
password=$(openssl rand -hex 32)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
# The temporary filename has no .p12 extension for security(1) to infer.
security import "$p12" -f pkcs12 -k "$keychain" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign
unset CSC_KEY_PASSWORD
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
unset password
search_list=()
while IFS= read -r path; do
  search_list+=("$path")
done < <(security list-keychains -d user | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
security list-keychains -d user -s "$keychain" "${search_list[@]}"

identities=$(security find-identity -v -p codesigning "$keychain")
identity=$(printf '%s\n' "$identities" | sed -En 's/^.*"(Developer ID Application: [^"]+)".*$/\1/p' |
  awk -v team=" ($APPLE_TEAM_ID)" 'substr($0, length($0)-length(team)+1) == team')
if [[ -z "$identity" || "$identity" == *$'\n'* ]]; then
  echo "::error::Expected one valid Developer ID Application identity for APPLE_TEAM_ID in CSC_LINK"
  exit 1
fi
printf 'APPLE_SIGNING_IDENTITY=%s\n' "$identity" >> "$GITHUB_ENV"
