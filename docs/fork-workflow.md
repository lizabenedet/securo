# Fork workflow — modificacoes proprias + atualizacoes do upstream

Como este fork (`lizabenedet/securo`) mantem funcionalidades proprias sem
perder as releases do upstream (`securo-finance/securo`).

## Estrutura

| Item | Papel |
| --- | --- |
| remote `upstream` | `securo-finance/securo` — so leitura, e de onde vem as releases |
| remote `origin` | `lizabenedet/securo` — o fork, onde seu trabalho vive |
| branch `main` | espelho da `main` do upstream, nunca receba commits seus |
| branch `custom` | **sua** branch: os seus commits, rebaseados sobre a tag de release mais recente |
| `docker-compose.custom.yml` | troca as imagens oficiais pelas suas no GHCR |
| `scripts/release-custom.sh` | builda as duas imagens e publica no GHCR |

Base atual da `custom`: `v0.14.5`.

## Desenvolver

O compose de desenvolvimento ja builda do codigo-fonte, entao nao ha nada de
especial a fazer:

```bash
git checkout custom
docker compose up --build
```

Duas regras que decidem o custo de cada atualizacao futura:

1. **Commits pequenos e tematicos.** Um assunto por commit. Uma mudanca
   espalhada por 20 arquivos vira 20 conflitos potenciais a cada release.
2. **Prefira arquivo novo a editar arquivo existente** quando a arquitetura
   permitir. Arquivo que so existe aqui nunca conflita.

O que for correcao generica, mande como PR para o upstream: assim deixa de ser
sua responsabilidade manter no rebase.

## Publicar na VPS

Na maquina de desenvolvimento (login no GHCR e necessario so na primeira vez —
PAT classic com escopo `write:packages`):

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u lizabenedet --password-stdin
./scripts/release-custom.sh v0.14.5-custom.1
```

Na VPS (Debian 13, x86_64). Sao **tres** arquivos de compose: sem o
`vps.yml` voce perde o Caddy (o HTTPS) e o Celery volta ao `--concurrency=2`,
que estoura a RAM de 964 MB da maquina.

```bash
cd ~/securo
# a `custom` e reescrita a cada rebase, entao `git pull` falha
git fetch origin && git reset --hard origin/custom
export SECURO_TAG=v0.14.5-custom.1
docker compose -f docker-compose.prod.yml \
  -f docker-compose.custom.yml -f docker-compose.vps.yml pull
docker compose -f docker-compose.prod.yml \
  -f docker-compose.custom.yml -f docker-compose.vps.yml up -d
```

Quando a release trouxer migration, tire o dump antes — algumas apagam linhas
e nao tem `downgrade` que desfaca (a 076 da v0.14.5 funde payees duplicados):

```bash
docker exec -i securo-db-1 pg_dump -U postgres securo > ~/backup-pre-<versao>.sql
docker exec -i securo-db-1 psql -U postgres -d securo -tAc 'select version_num from alembic_version'
```

Rollback e so subir de novo apontando `SECURO_TAG` para a versao anterior — as
imagens antigas continuam no GHCR.

### Primeira instalacao da VPS

```bash
curl -fsSL https://get.docker.com | sh      # o docker.io do Debian nao traz o plugin compose v2
sudo usermod -aG docker "$USER"             # relogar depois
git clone -b custom https://github.com/lizabenedet/securo.git ~/securo
cd ~/securo
cp .env.example .env                        # ajuste SECRET_KEY, FRONTEND_URL, etc.
```

`.env` e `secrets/` sao ignorados pelo git de proposito: copie-os manualmente
para a VPS, nunca commite.

## Atualizar quando sair uma release nova

```bash
git fetch upstream --tags
git checkout custom
git rebase v0.15.0            # a tag nova

# resolva conflitos, se houver:
#   git add <arquivo> && git rebase --continue
#   git rebase --abort        para desistir e voltar ao estado anterior

docker compose up --build     # teste local antes de publicar
git push --force-with-lease   # a branch foi reescrita; --force-with-lease protege contra sobrescrever trabalho remoto
./scripts/release-custom.sh v0.15.0-custom.1
```

Manter a `main` local em dia (opcional, util para consultar o codigo oficial):

```bash
git checkout main && git pull upstream main
```

## Licenca

O Securo e AGPL-3.0. Uso proprio na sua VPS nao exige nada. Se voce expuser
esta versao modificada pela rede para terceiros, precisa oferecer a eles o
codigo-fonte modificado — que ja esta publico neste fork.
