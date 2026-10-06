#!/usr/bin/env bash
# Libera (ou, com --remove, fecha) a porta TCP 8443 do relay do global-agents no iptables da VPS.
#
#   sudo bash firewall.sh            # insere a regra antes do REJECT final da cadeia INPUT
#   sudo bash firewall.sh --remove   # apaga exatamente essa regra
#
# Só mexe na regra do 8443: nenhuma outra regra é removida, trocada ou reordenada. É idempotente
# (checa com `iptables -C` antes de inserir ou apagar).
set -euo pipefail

PORTA=8443
REGRA=(-p tcp --dport "$PORTA" -m state --state NEW -j ACCEPT)

if [[ "${1:-}" != "" && "${1:-}" != "--remove" ]]; then
  echo "uso: sudo bash firewall.sh [--remove]" >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "erro: rode como root (sudo bash firewall.sh)." >&2
  exit 1
fi
if ! command -v iptables >/dev/null 2>&1; then
  echo "erro: iptables não encontrado." >&2
  exit 1
fi

persistir() {
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save
    echo "regras salvas com netfilter-persistent."
  else
    echo "aviso: netfilter-persistent não está instalado; a regra some no próximo reboot." >&2
    echo "       para persistir: sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save" >&2
  fi
}

if [[ "${1:-}" == "--remove" ]]; then
  if iptables -C INPUT "${REGRA[@]}" 2>/dev/null; then
    iptables -D INPUT "${REGRA[@]}"
    echo "regra do ${PORTA} removida."
    persistir
  else
    echo "a regra do ${PORTA} não existe; nada a remover."
  fi
  exit 0
fi

if iptables -C INPUT "${REGRA[@]}" 2>/dev/null; then
  echo "a regra do ${PORTA} já existe; nada a fazer."
  exit 0
fi

# Posição da primeira regra REJECT da cadeia INPUT (a nova regra tem que ficar antes dela).
posicao="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
if [[ -n "$posicao" ]]; then
  iptables -I INPUT "$posicao" "${REGRA[@]}"
  echo "regra do ${PORTA} inserida na posição ${posicao} de INPUT (antes do REJECT)."
else
  iptables -A INPUT "${REGRA[@]}"
  echo "INPUT não tem REJECT; regra do ${PORTA} adicionada no fim."
fi
iptables -L INPUT --line-numbers -n
persistir
