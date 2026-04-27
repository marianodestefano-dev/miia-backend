#!/usr/bin/env bash
# r_v0_smoke.sh — guard R-V0 multi-repo (CLAUDE.md §5-bis).
# Ejecutar antes de cualquier `git add` en miia-backend o miia-frontend.
# Verifica que ambos repos están en `main` (default) o en la rama firmada
# explícitamente vía R_V0_ALLOW_BRANCH (ej: feature/fortaleza para §2-ter).
#
# Origen: incidente C-410 cierre 2026-04-25. Doctrina sin red de seguridad
# técnica → C-426 §D agrega este smoke.
#
# Uso:
#   bash miia-backend/scripts/r_v0_smoke.sh
#   R_V0_ALLOW_BRANCH=feature/fortaleza bash miia-backend/scripts/r_v0_smoke.sh
#
# Exit codes:
#   0 = ambos repos OK
#   1 = al menos uno violación R-V0
#   2 = error de configuración (path inválido, no es repo git)

set -u

PROJECT_ROOT="${MIIA_PROJECT_ROOT:-c:/Users/usuario/OneDrive/Desktop/miia}"
BACKEND_PATH="${MIIA_BACKEND_PATH:-${PROJECT_ROOT}/miia-backend}"
FRONTEND_PATH="${MIIA_FRONTEND_PATH:-${PROJECT_ROOT}/miia-frontend}"
ALLOW_BRANCH="${R_V0_ALLOW_BRANCH:-}"

check_repo() {
  local label="$1"
  local repo_path="$2"

  if [ ! -d "$repo_path" ]; then
    echo "ERR ${label}: path '$repo_path' no existe"
    return 2
  fi

  if [ ! -d "$repo_path/.git" ]; then
    echo "ERR ${label}: '$repo_path' no es repo git"
    return 2
  fi

  local branch
  branch=$(cd "$repo_path" && git branch --show-current 2>&1)
  if [ -z "$branch" ]; then
    echo "ERR ${label}: branch detached o vacío en '$repo_path'"
    return 1
  fi

  if [ "$branch" = "main" ]; then
    echo "OK  ${label}: branch=main"
    return 0
  fi

  if [ -n "$ALLOW_BRANCH" ] && [ "$branch" = "$ALLOW_BRANCH" ]; then
    echo "OK  ${label}: branch=${branch} (allow-listed via R_V0_ALLOW_BRANCH)"
    return 0
  fi

  echo "FAIL ${label}: R-V0 violation — branch='${branch}' (esperado main"
  if [ -n "$ALLOW_BRANCH" ]; then
    echo "                              o allow='${ALLOW_BRANCH}')"
  else
    echo "                              o setear R_V0_ALLOW_BRANCH explícito)"
  fi
  return 1
}

fails=0
check_repo "miia-backend " "$BACKEND_PATH" || fails=$((fails + $?))
check_repo "miia-frontend" "$FRONTEND_PATH" || fails=$((fails + $?))

if [ $fails -eq 0 ]; then
  echo "—"
  echo "R-V0 smoke OK — ambos repos en branch permitido."
  exit 0
fi

echo "—"
echo "R-V0 smoke FAIL — corregir antes de git add."
exit 1
