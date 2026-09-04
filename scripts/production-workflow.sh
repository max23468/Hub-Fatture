#!/bin/sh
set -eu

find_successful_base() {
  deployments=$(gh api "$1" --jq '.[] | [.id, .sha] | @tsv')
  [ -n "$deployments" ] || return
  while IFS="$(printf '\t')" read -r deployment sha; do
    successful=$(gh api "repos/$GITHUB_REPOSITORY/deployments/$deployment/statuses?per_page=100" --jq 'any(.[]; .state == "success")')
    if [ "$successful" = true ]; then
      printf '%s\n' "$sha"
      return
    fi
  done <<EOF
$deployments
EOF
}

candidate() {
  git fetch --no-tags origin main
  git cat-file -e "$CANDIDATE^{commit}"
  test "$(git rev-parse "$CANDIDATE")" = "$CANDIDATE"
  git merge-base --is-ancestor "$CANDIDATE" origin/main
  git checkout --detach "$CANDIDATE"
  echo "commit=$CANDIDATE" >> "$GITHUB_OUTPUT"
  echo "version=$(jq -r .version package.json)" >> "$GITHUB_OUTPUT"
}

impact() {
  base=$(find_successful_base "repos/$GITHUB_REPOSITORY/deployments?environment=Production&task=hub-fatture-production&per_page=100")
  if [ -z "$base" ]; then
    base=0000000000000000000000000000000000000000
    check_base=$base
    rollback=false
    impact_base=$base
    impact_head=$CANDIDATE
  elif git merge-base --is-ancestor "$base" "$CANDIDATE"; then
    check_base=$base
    rollback=false
    impact_base=$base
    impact_head=$CANDIDATE
  elif git merge-base --is-ancestor "$CANDIDATE" "$base"; then
    check_base=0000000000000000000000000000000000000000
    rollback=true
    impact_base=$CANDIDATE
    impact_head=$base
  else
    echo "Il candidato e il deployment corrente non appartengono alla stessa linea di main." >&2
    exit 1
  fi
  {
    echo "base=$base"
    echo "check_base=$check_base"
    echo "rollback=$rollback"
    node "$TRUSTED_TOOLING/change-impact.mjs" "$impact_base" "$impact_head"
  } >> "$GITHUB_OUTPUT"
}

summary() {
  echo "Corsia dal commit distribuito - $LANE" >> "$GITHUB_STEP_SUMMARY"
  if [ "$RUNTIME" != true ]; then
    echo "Nessun artefatto runtime modificato: deploy non applicabile." >> "$GITHUB_STEP_SUMMARY"
  fi
}

reuse_artifact() {
  artifact_run=
  artifact_done=false
  artifact_expected=true
  if [ "$ROLLBACK" = true ] || [ "$RECOVERY" = true ]; then
    artifact_done=true
    artifact_expected=false
  else
    for _ in $(seq 1 120); do
      if [ -z "$artifact_run" ]; then
        artifact_run=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/production-artifact.yml/runs?head_sha=$CANDIDATE&event=push&per_page=10" --jq '.workflow_runs | sort_by(.created_at) | last | .id // empty')
      fi
      if [ -n "$artifact_run" ]; then
        read -r status conclusion <<EOF
$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$artifact_run" --jq '[.status, (.conclusion // "")] | @tsv')
EOF
        if [ "$status" = completed ]; then
          test "$conclusion" = success || {
            echo "Il workflow Production artifact $artifact_run è terminato con $conclusion." >&2
            exit 1
          }
          artifact_done=true
          break
        fi
      fi
      sleep 10
    done
  fi
  test "$artifact_done" = true || {
    echo "Il workflow Production artifact non si è concluso entro venti minuti." >&2
    exit 1
  }
  tag="ghcr.io/max23468/hub-fatture:sha-$CANDIDATE"
  reuse_attempts=1
  if [ "$artifact_expected" = true ]; then
    reuse_attempts=12
  fi
  for attempt in $(seq 1 "$reuse_attempts"); do
    digest=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>/dev/null || true)
    if printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
      && gh attestation verify "oci://ghcr.io/max23468/hub-fatture@$digest" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
      echo "digest=$digest" >> "$GITHUB_OUTPUT"
      echo "reused=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    if [ "$attempt" -lt "$reuse_attempts" ]; then
      echo "Artefatto exact-SHA non ancora verificabile; nuovo tentativo tra cinque secondi ($attempt/$reuse_attempts)."
      sleep 5
    fi
  done
  echo "reused=false" >> "$GITHUB_OUTPUT"
}

prepare_ssh() {
  install -d -m 700 ~/.ssh
  printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  printf '%s\n' "$SSH_HOST_KEY" > ~/.ssh/known_hosts
  chmod 600 ~/.ssh/known_hosts
}

baseline() {
  # La ricevuta VPS resta autorevole; lo storico GitHub non richiede accesso anticipato ai secret Production.
  # shellcheck disable=SC2029
  live_receipt=$(ssh "$SSH_USER@$SSH_HOST" "if sudo test -f /opt/hub-fatture/data/operations/deploy-receipt.json; then sudo cat /opt/hub-fatture/data/operations/deploy-receipt.json; fi")
  deploy_runtime=$CANDIDATE_RUNTIME
  effective_rollback=$ROLLBACK
  if [ -z "$live_receipt" ]; then
    test "$BACKUP_ONLY" != true || {
      echo "Il backup readiness richiede una ricevuta live." >&2
      exit 1
    }
    deploy_runtime=true
    echo "Ricevuta assente: esecuzione del percorso di bootstrap Production." >> "$GITHUB_STEP_SUMMARY"
  else
    live_base=$(printf '%s' "$live_receipt" | jq -er .commit)
    live_digest=$(printf '%s' "$live_receipt" | jq -er .imageDigest)
    rollback_digest=$(ssh "$SSH_USER@$SSH_HOST" "if sudo test -f /opt/hub-fatture/data/operations/rollback.env; then sudo sed -n 's/^APP_IMAGE_DIGEST=//p' /opt/hub-fatture/data/operations/rollback.env; fi")
    printf '%s' "$live_base" | grep -Eq '^[0-9a-f]{40}$'
    printf '%s' "$live_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
    if [ -n "$rollback_digest" ]; then
      printf '%s' "$rollback_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
    fi
    git cat-file -e "$live_base^{commit}"
    if [ "$live_base" != "$EXPECTED_BASE" ]; then
      if [ "$live_base" = "$CANDIDATE" ]; then
        effective_rollback=$ROLLBACK
      elif git merge-base --is-ancestor "$live_base" "$CANDIDATE"; then
        effective_rollback=false
      elif git merge-base --is-ancestor "$CANDIDATE" "$live_base"; then
        effective_rollback=true
      else
        echo "Il candidato e la ricevuta live non appartengono alla stessa linea di main." >&2
        exit 1
      fi
      if [ "$EXPECTED_BASE" != 0000000000000000000000000000000000000000 ] \
        && ! git merge-base --is-ancestor "$EXPECTED_BASE" "$live_base" \
        && ! git merge-base --is-ancestor "$live_base" "$EXPECTED_BASE"; then
        echo "La baseline GitHub e la ricevuta live non appartengono alla stessa linea di main." >&2
        exit 1
      fi
      deployment=$(jq -n --arg ref "$live_base" '{ref:$ref,environment:"Production",task:"hub-fatture-production",description:"Riconciliazione da ricevuta live verificata",auto_merge:false,required_contexts:[]}' | gh api "repos/$GITHUB_REPOSITORY/deployments" --input - --jq .id)
      gh api "repos/$GITHUB_REPOSITORY/deployments/$deployment/statuses" -X POST -f state=success -f environment=Production -f environment_url=https://fatture.opik.net -f description="Baseline riconciliata dalla ricevuta live" >/dev/null
    fi
    if [ "$BACKUP_ONLY" = true ]; then
      test "$live_base" = "$CANDIDATE" || {
        echo "Il backup readiness è ammesso soltanto per il commit live esatto." >&2
        exit 1
      }
    fi
    if [ "$CANDIDATE_RUNTIME" != true ]; then
      test "$live_base" = "$CANDIDATE" || {
        echo "Il recupero della release è ammesso soltanto per il commit live esatto." >&2
        exit 1
      }
    fi
    if [ "$live_base" = "$CANDIDATE" ]; then
      deploy_runtime=false
      echo "Il candidato è già live: il redeploy viene saltato." >> "$GITHUB_STEP_SUMMARY"
    fi
  fi
  echo "deploy_runtime=$deploy_runtime" >> "$GITHUB_OUTPUT"
  echo "rollback=$effective_rollback" >> "$GITHUB_OUTPUT"
}

backup_readiness() {
  schema=$(find migrations -maxdepth 1 -type f -name '*.sql' -print | sed 's#^.*/##' | sort | tail -n 1)
  remote_script="/tmp/hub-fatture-backup-$CANDIDATE.sh"
  scp scripts/backup.sh "$SSH_USER@$SSH_HOST:$remote_script"
  # shellcheck disable=SC2029
  receipt=$(ssh "$SSH_USER@$SSH_HOST" "set -e; trap 'rm -f \"$remote_script\"' EXIT; chmod 700 '$remote_script'; test \"\$(sudo jq -er .commit /opt/hub-fatture/data/operations/deploy-receipt.json)\" = '$CANDIDATE'; sudo env HUB_FATTURE_ROOT=/opt/hub-fatture '$remote_script' readiness >/dev/null; sudo jq -cs '.[1] + {deployedImageDigest:.[0].imageDigest}' /opt/hub-fatture/data/operations/deploy-receipt.json /opt/hub-fatture/data/operations/backup-receipt.json")
  backup=$(printf '%s\n' "$receipt" | tail -n 1)
  printf '%s' "$backup" | jq -e --arg commit "$CANDIDATE" --arg version "$VERSION" --arg schema "$schema" '
    .status == "ok"
    and .commit == $commit
    and .version == $version
    and .schema == $schema
    and .objectName == "hub-fatture/current/latest.tar.age"
    and (.imageDigest | test("^sha256:[0-9a-f]{64}$"))
    and .imageDigest == .deployedImageDigest
    and (.sha256 | test("^[0-9a-f]{64}$"))
    and (.sizeBytes > 0)
    and (.archiveObjectName | contains($commit))
    and .archiveKind == "DATABASE_JOURNAL"
    and (.archiveSha256 | test("^[0-9a-f]{64}$"))
    and (.archiveSizeBytes > 0)
    and (.archiveSizeBytes < .sizeBytes)
  ' >/dev/null
  printf 'Ricevuta backup verificata: %s\n' "$backup"
}

rollback_preflight() {
  [ "$ROLLBACK" = true ] || return 0
  candidate_schema=$(find migrations -maxdepth 1 -type f -name '*.sql' -print | sed 's#^.*/##' | sort | tail -n 1)
  test -n "$candidate_schema"
  # shellcheck disable=SC2029
  deployed_schema=$(ssh "$SSH_USER@$SSH_HOST" "sudo jq -er .schema /opt/hub-fatture/data/operations/deploy-receipt.json")
  test "$candidate_schema" = "$deployed_schema" || {
    echo "Rollback vietato: lo schema Production è avanzato rispetto al candidato." >&2
    exit 1
  }
  if ! grep -Fq 'z.enum(["AUTOMATIC", "MANUAL", "DISABLED"])' src/db/email.server.ts; then
    # shellcheck disable=SC2029
    customer_email_mode=$(ssh "$SSH_USER@$SSH_HOST" "cd /opt/hub-fatture && sudo docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres psql -U hub_fatture -d hub_fatture -Atc \"SELECT value_json #>> '{}' FROM settings WHERE key = 'customer_email_mode'\"")
    test "$customer_email_mode" != DISABLED || {
      echo "Rollback vietato: il candidato non supporta la disattivazione delle e-mail al cliente attiva in Production." >&2
      exit 1
    }
  fi
}

create_deployment() {
  deployment=$(jq -n --arg ref "$CANDIDATE" '{ref:$ref,environment:"Production",task:"hub-fatture-production",description:"Hub Fatture Production exact candidate",auto_merge:false,required_contexts:[]}' | gh api "repos/$GITHUB_REPOSITORY/deployments" --input - --jq .id)
  echo "id=$deployment" >> "$GITHUB_OUTPUT"
  gh api "repos/$GITHUB_REPOSITORY/deployments/$deployment/statuses" -X POST -f state=in_progress -f environment=Production -f environment_url=https://fatture.opik.net -f description="Deploy exact-SHA in corso" >/dev/null
}

install_candidate() {
  target="/tmp/hub-fatture-$COMMIT"
  # shellcheck disable=SC2029
  ssh "$SSH_USER@$SSH_HOST" "install -d -m 700 '$target'"
  scp compose.production.yaml ops/Caddyfile.production ops/systemd/* \
    scripts/backup.sh scripts/monitor-local.sh scripts/prune-docker-images.sh \
    scripts/restore.sh scripts/production-*.sh scripts/read-env.sh \
    "$SSH_USER@$SSH_HOST:$target/"
  # shellcheck disable=SC2029
  ssh "$SSH_USER@$SSH_HOST" "sudo chmod 750 '$target/'*.sh && sudo install -m 640 '$target/compose.production.yaml' /opt/hub-fatture/compose.yaml.next && sudo install -m 640 '$target/Caddyfile.production' /opt/hub-fatture/Caddyfile.next && if [ '$BACKUP_REQUIRED' = true ] && sudo test -f /opt/hub-fatture/.deploy.env && sudo test -f /opt/hub-fatture/data/operations/deploy-receipt.json; then sudo env HUB_FATTURE_ROOT=/opt/hub-fatture /opt/hub-fatture/scripts/backup.sh pre-deploy; elif sudo test -f /opt/hub-fatture/.deploy.env; then sudo jq -e '.status == \"ok\" and ((.completedAt | fromdateiso8601) >= (now - 129600))' /opt/hub-fatture/data/operations/backup-receipt.json >/dev/null; fi && sudo env HUB_FATTURE_CANDIDATE_DIR='$target' '$target/production-deploy.sh' '$DIGEST' '$COMMIT' '$VERSION' && sudo install -m 750 '$target/backup.sh' '$target/monitor-local.sh' '$target/prune-docker-images.sh' '$target/read-env.sh' '$target/restore.sh' '$target/production-preflight.sh' '$target/production-readback.sh' '$target/production-release-candidate-readback.sh' '$target/production-submission-mode.sh' '$target/production-deploy.sh' /opt/hub-fatture/scripts/ && sudo install -m 644 '$target/'*.service '$target/'*.timer /etc/systemd/system/ && if [ '$BACKUP_REQUIRED' = true ]; then sudo /opt/hub-fatture/scripts/backup.sh deploy; fi && if sudo test -f /opt/hub-fatture/data/operations/rollback.env; then sudo /opt/hub-fatture/scripts/prune-docker-images.sh; fi && sudo systemctl daemon-reload && sudo systemctl enable --now hub-fatture-backup.timer hub-fatture-monitor.timer && rm -rf '$target'"
}

register_deployment() {
  for delay in 0 2 5 10 20 30; do
    sleep "$delay"
    if gh api "repos/$GITHUB_REPOSITORY/deployments/$DEPLOYMENT/statuses" -X POST -f state=success -f environment=Production -f environment_url=https://fatture.opik.net -f description="Deploy exact-SHA verificato" >/dev/null; then
      exit 0
    fi
    echo "Registrazione terminale non riuscita; nuovo tentativo tra poco." >&2
  done
  echo "Deploy live riuscito ma stato GitHub non registrato: la prossima esecuzione riconcilierà la ricevuta VPS." >&2
  exit 1
}

release_state() {
  # shellcheck disable=SC2029
  live_receipt=$(ssh "$SSH_USER@$SSH_HOST" "sudo cat /opt/hub-fatture/data/operations/deploy-receipt.json")
  live_base=$(printf '%s' "$live_receipt" | jq -er .commit)
  live_digest=$(printf '%s' "$live_receipt" | jq -er .imageDigest)
  test "$live_base" = "$CANDIDATE"
  printf '%s' "$live_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
  rollback_digest=$(ssh "$SSH_USER@$SSH_HOST" "if sudo test -f /opt/hub-fatture/data/operations/rollback.env; then sudo sed -n 's/^APP_IMAGE_DIGEST=//p' /opt/hub-fatture/data/operations/rollback.env; fi")
  if [ -n "$rollback_digest" ]; then
    printf '%s' "$rollback_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
  fi
  echo "live_digest=$live_digest" >> "$GITHUB_OUTPUT"
  echo "rollback_digest=$rollback_digest" >> "$GITHUB_OUTPUT"
}

publish_release() {
  schema=$(find migrations -maxdepth 1 -type f -name '*.sql' -print | sed 's#^.*/##' | sort | tail -n 1)
  bundle_url=$(gh api "repos/$GITHUB_REPOSITORY/attestations/$IMAGE_DIGEST" --jq '.attestations[0].bundle_url // empty')
  attestation_id=$(node -e 'const match = new URL(process.argv[1]).pathname.match(/\/(\d+)(?:\.json\.sn)?\/?$/); if (!match) process.exit(1); process.stdout.write(match[1]);' "$bundle_url")
  printf '%s' "$attestation_id" | grep -Eq '^[0-9]+$'
  attestation="https://github.com/$GITHUB_REPOSITORY/attestations/$attestation_id"
  stage=$(mktemp -d "${RUNNER_TEMP}/hub-fatture-release.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
  node scripts/prepare-production-release.mjs "$stage" "$VERSION" "$COMMIT" \
    "$IMAGE_DIGEST" "$ROLLBACK_DIGEST" "$schema" "$attestation"
  scripts/publish-github-release.sh "v$VERSION" "$COMMIT" \
    "$stage/release-manifest.json" "$stage/release-notes.md"
}

case ${1:-} in
  candidate) candidate ;;
  impact) impact ;;
  summary) summary ;;
  reuse-artifact) reuse_artifact ;;
  prepare-ssh) prepare_ssh ;;
  baseline) baseline ;;
  backup-readiness) backup_readiness ;;
  rollback-preflight) rollback_preflight ;;
  create-deployment) create_deployment ;;
  install-candidate) install_candidate ;;
  register-deployment) register_deployment ;;
  release-state) release_state ;;
  publish-release) publish_release ;;
  *) echo "Comando Production non valido" >&2; exit 2 ;;
esac
