#!/usr/bin/env bash
# Libera (ou, com --remove, fecha) a porta TCP 8443 do relay do global-agents no iptables da VPS.
#
#   sudo bash firewall.sh            # regra viva antes do REJECT final de INPUT + linha em /etc/iptables/rules.v4
#   sudo bash firewall.sh --remove   # desfaz as duas coisas
#
# Só mexe na regra do 8443: nenhuma outra regra é removida, trocada ou reordenada. É idempotente.
# Persistência: NÃO usa `netfilter-persistent save`, que gravaria as cadeias do Docker de outros projetos no
# arquivo de regras (e conflitaria com o Docker no boot). Em vez disso edita só o /etc/iptables/rules.v4
# existente, com backup (rules.v4.bak-<data>) e escrita atômica.
#
# Variáveis (para teste): RULES_FILE aponta outro arquivo; SKIP_LIVE=1 não toca no iptables nem exige root.
set -euo pipefail

PORTA=8443
REGRA=(-p tcp --dport "$PORTA" -m state --state NEW -j ACCEPT)
LINHA="-A INPUT -p tcp -m state --state NEW -m tcp --dport ${PORTA} -j ACCEPT"
RULES_FILE="${RULES_FILE:-/etc/iptables/rules.v4}"
SKIP_LIVE="${SKIP_LIVE:-0}"

if [[ "${1:-}" != "" && "${1:-}" != "--remove" ]]; then
  echo "uso: sudo bash firewall.sh [--remove]" >&2
  exit 2
fi
if [[ "$SKIP_LIVE" != "1" ]]; then
  if [[ ${EUID} -ne 0 ]]; then
    echo "erro: rode como root (sudo bash firewall.sh)." >&2
    exit 1
  fi
  if ! command -v iptables >/dev/null 2>&1; then
    echo "erro: iptables não encontrado." >&2
    exit 1
  fi
fi

# Grava $1 (arquivo temporário) sobre RULES_FILE depois de fazer o backup; mantém dono e permissões.
publicar() {
  local novo="$1" bak
  bak="${RULES_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$RULES_FILE" "$bak"
  chmod --reference="$RULES_FILE" "$novo"
  chown --reference="$RULES_FILE" "$novo" 2>/dev/null || true
  mv -f "$novo" "$RULES_FILE"
  echo "backup em ${bak}"
}

persistir_adicionar() {
  if [[ ! -f "$RULES_FILE" ]]; then
    echo "aviso: ${RULES_FILE} não existe; não vou criá-lo (um arquivo novo poderia travar o boot)." >&2
    echo "       a regra do ${PORTA} vale agora, mas NÃO sobrevive a um reboot; reaplique com este script depois dele." >&2
    return 0
  fi
  if grep -qxF -- "$LINHA" "$RULES_FILE"; then
    echo "${RULES_FILE} já tem a regra do ${PORTA}."
    return 0
  fi
  local tmp
  tmp="$(mktemp "${RULES_FILE}.XXXXXX")"
  # Antes do primeiro `-A INPUT ... -j REJECT`; sem REJECT, antes do primeiro COMMIT.
  if grep -qE '^-A INPUT .*-j REJECT' "$RULES_FILE"; then
    awk -v l="$LINHA" '!d && /^-A INPUT .*-j REJECT/ { print l; d=1 } { print }' "$RULES_FILE" > "$tmp"
  else
    awk -v l="$LINHA" '!d && /^COMMIT/ { print l; d=1 } { print }' "$RULES_FILE" > "$tmp"
  fi
  publicar "$tmp"
  echo "regra do ${PORTA} gravada em ${RULES_FILE}."
}

persistir_remover() {
  if [[ ! -f "$RULES_FILE" ]] || ! grep -qxF -- "$LINHA" "$RULES_FILE"; then
    echo "${RULES_FILE} não tem a regra do ${PORTA}; nada a remover lá."
    return 0
  fi
  local tmp
  tmp="$(mktemp "${RULES_FILE}.XXXXXX")"
  grep -vxF -- "$LINHA" "$RULES_FILE" > "$tmp" || true
  publicar "$tmp"
  echo "regra do ${PORTA} removida de ${RULES_FILE}."
}

if [[ "${1:-}" == "--remove" ]]; then
  if [[ "$SKIP_LIVE" != "1" ]]; then
    if iptables -C INPUT "${REGRA[@]}" 2>/dev/null; then
      iptables -D INPUT "${REGRA[@]}"
      echo "regra viva do ${PORTA} removida."
    else
      echo "a regra viva do ${PORTA} não existe; nada a remover."
    fi
  fi
  persistir_remover
  exit 0
fi

if [[ "$SKIP_LIVE" != "1" ]]; then
  if iptables -C INPUT "${REGRA[@]}" 2>/dev/null; then
    echo "a regra viva do ${PORTA} já existe."
  else
    # Posição da primeira regra REJECT de INPUT (a nova regra tem que ficar antes dela).
    posicao="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
    if [[ -n "$posicao" ]]; then
      iptables -I INPUT "$posicao" "${REGRA[@]}"
      echo "regra do ${PORTA} inserida na posição ${posicao} de INPUT (antes do REJECT)."
    else
      iptables -A INPUT "${REGRA[@]}"
      echo "INPUT não tem REJECT; regra do ${PORTA} adicionada no fim."
    fi
  fi
  iptables -L INPUT --line-numbers -n
fi
persistir_adicionar
