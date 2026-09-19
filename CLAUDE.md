# Securo — fork `custom`

Fork de `securo-finance/securo`. O trabalho fica todo na branch **`custom`**,
que é rebaseada sobre as releases do upstream (v0.14.4 → v0.14.5 sem conflito;
v0.14.5 → v0.15.0 com um só, um bloco de `import` no `frontend/src/lib/api.ts`
onde os dois lados acrescentaram nomes; v0.15.0 → v0.15.1 com três, e dois
commits nossos descartados porque o upstream tinha feito o mesmo; v0.15.1 →
v0.16.0 com cinco, todos de "os dois lados acrescentaram no mesmo ponto", e a
migration de cartões colidindo pela segunda vez). Instalação e uso geral estão no `README.md`; este arquivo
cobre só o que é específico deste fork.

> Infraestrutura (host da VPS, usuário SSH, caminhos) **não entra aqui** — este
> arquivo é versionado. Esses dados estão na memória do projeto.

## Estado atual

- No ar: **`v0.16.0-custom.1`** (a UI mostra `v0.16.0+custom.1`), publicada e
  em produção desde 19/09/2026.
- Revisão do banco: a head é **`fork001`**, a nossa (cria `cards` e a coluna
  `transactions.card_id`), encadeada **depois** da head do upstream (`089` na
  v0.16.0). Produção e local estão em `fork001` desde 19/09/2026.
- O módulo `cards` em `module_service.py` é travado por lista literal em três
  testes; um rebase que mexa nessa lista pede olhar os três.

### Migrations do fork ficam fora da numeração do upstream

A migration de cartões nasceu `085`, virou `086` quando a v0.15.1 tomou a 085, e
colidiu de novo quando a v0.16.0 trouxe 086–089. Desde 19/09/2026 ela é
**`fork001`** — um id que o upstream nunca vai usar. A cada rebase, basta
apontar o `down_revision` dela para a nova head do upstream; o
`backend/scripts/check_migration_chain.py` confirma que a cadeia ficou uma linha
só. Migration nova do fork segue `fork002_...`, e assim por diante (o
verificador exige que o nome do arquivo comece pelo id até o primeiro `_`).

A `fork001` só cria alguma coisa quando a tabela `cards` não existe. Isso
cobre banco novo, mas **não** conserta o marcador de um banco que a rodou com
número antigo: lá o `alembic_version` diz `085` ou `086` querendo dizer
*cards*, e o código novo lê esses números como migrations do upstream que o
banco nunca rodou.

**Todo banco nessa situação precisa de um conserto único** —
`scripts/reconcile-cards-migration.sql`. Ele reconhece o marcador nosso (há
`cards`, mas não há `reconciliation_rules`, a tabela da 086 do upstream),
acrescenta a coluna da 085 do upstream se faltar e volta o marcador para
`085`. O `upgrade head` então roda 086–089 do upstream e passa pela `fork001`
sem recriar nada — nome de cartão digitado pela usuária sobrevive. É
idempotente. Ensaiado em 19/09/2026 num dump da produção: cartões idênticos
linha por linha, painel e contas com os mesmos números da produção.
Substitui o antigo `reconcile-085-collision.sql`.

## Ambiente local

```bash
docker compose up -d              # backend, frontend, db (pgvector/pg16), redis, celery
cd frontend && npm run dev        # front fora do container, se preferir
cd backend && pip install -e ".[dev]" && pytest
```

**Validar o frontend com `npm run build`** — na v0.15.0 virou
`npm run typecheck && vite build`, com o TypeScript 7 nativo e o Vite 8. Nunca
validar com `tsc --noEmit`: o `--noEmit` não pega os mesmos erros e já deixou
uma imagem quebrar. Depois de um rebase, rode `npm ci` antes do build — a
v0.15.0 trocou a versão de quase toda a cadeia. `pytest` rodado *dentro* do container produz ~55 falhas de ambiente
(`AGENTS_ENABLED=false`, OIDC do compose) — são ruído, não regressão. Rodado no
venv local (`backend/.venv`), fecha em **3.885 passando** com **uma** falha,
do módulo de faturamento, que não usamos, e anterior a qualquer mudança nossa:
`test_invoice_document.py::test_a_line_taller_than_a_page_still_finishes`
(as outras duas do faturamento acabaram na v0.16.0). No frontend, `npx vitest
run` fecha em 758/759: a que falha espera nome de mês em inglês e o Windows
daqui responde em português.

As 14 falhas do faturamento que só apareciam **depois das 21h** — ele calculava
"hoje" em UTC e virava o dia antes do resto do app — **acabaram na v0.15.1**,
que prendeu essa suíte a um relógio próprio.

## Commits

Mensagens em **inglês**, no estilo Conventional Commits do upstream
(`feat(reports): ...`, `fix(calendar): ...`), mesmo quando a conversa é em
português.

## Publicar uma versão

Build **sempre na máquina local** — a VPS tem 964 MB de RAM e o `vite build`
estoura lá.

```bash
git push origin custom
bash scripts/release-custom.sh v0.14.5-custom.N     # builda, marca e empurra para o GHCR
```

O `N` incrementa a cada release do fork. A tag da imagem usa `-custom.N`, mas a
versão exibida na UI usa **`+custom.N`** — o script converte. Em SemVer,
`-custom.N` é pré-lançamento, e o app acenderia sozinho um aviso de update
apontando para a versão que já está rodando.

## Deploy

Na VPS, sempre com os **três** arquivos de compose — sem o `vps.yml` o Caddy
sai (o HTTPS cai) e o celery volta a `--concurrency=2`, que estoura a RAM:

```bash
git fetch origin && git reset --hard origin/custom
# grave SECURO_TAG=<tag> no .env — não use só `export`, ou um `up -d` futuro
# rebaixa a versão em silêncio (já aconteceu)
docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml -f docker-compose.vps.yml pull
docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml -f docker-compose.vps.yml up -d
```

O conserto da migration de cartões **já foi aplicado** na produção e no local em
19/09/2026 — um deploy normal não precisa mais dele. Ele só volta a ser
necessário se aparecer um banco que ainda marca `085` ou `086` para os cartões
(um dump antigo restaurado, por exemplo). Como é na partida que o backend roda o
`alembic upgrade head`, o conserto vem antes de ele subir. Entre o `pull`
e o `up -d`:

```bash
C="docker compose -f docker-compose.prod.yml -f docker-compose.custom.yml -f docker-compose.vps.yml"
$C stop backend celery-worker celery-beat
docker exec securo-db-1 pg_dump -U postgres -d securo --clean --if-exists > ~/securo-pre-fork001-$(date +%F).dump
docker exec -i securo-db-1 psql -U postgres -d securo -v ON_ERROR_STOP=1 < scripts/reconcile-cards-migration.sql
$C up -d
```

Espere o `NOTICE` dizendo que o marcador foi para 085 e, no log do backend, as
linhas `Running upgrade 085 -> 086` … `089 -> fork001`. Rodar o conserto de novo
num banco já acertado só diz que não há nada a mover.

## Banco de dados

**A produção é a fonte de verdade dos dados.** É lá que a sincronização entra e
onde as edições pela tela são feitas — em 01/09/2026 a produção tinha 250
categorizações, uma categoria nova e 12 lançamentos que o banco local não tinha.
A direção padrão é **produção → local**; o local é cópia de trabalho, para
experimentar e para conferir uma correção antes de aplicá-la.

Isto **inverteu** a regra anterior ("o banco local manda"), que valia enquanto as
correções em massa eram feitas aqui e empurradas para lá. Restaurar o local por
cima da produção hoje apagaria trabalho feito na tela.

### Correção pontual (o caminho normal)

Poucas linhas — recategorizar, desparear, marcar ignorado — vão **direto na
produção**, por SQL, sem parar nada:

1. backup antes: `docker exec securo-db-1 pg_dump -U postgres -d securo
   --clean --if-exists > ~/securo-pre-<motivo>-<data>.dump`
2. rodar o `UPDATE`/`DELETE` dentro de `BEGIN; ... COMMIT;`, imprimindo antes o
   que vai mudar
3. conferir o efeito e repetir o mesmo comando no local, para os dois não
   divergirem

É preferível ao restore: não derruba o app e não atropela o que sincronizou no
meio do caminho.

### Trazer a produção para o local

```bash
ssh <vps> "docker exec securo-db-1 pg_dump -U postgres -d securo --clean --if-exists" > prod-<data>.sql
docker compose up -d db
docker exec securo-db-1 pg_dump -U postgres -d securo --clean --if-exists > local-antes-<data>.sql  # rede de segurança
docker exec -i securo-db-1 psql -U postgres -d securo < prod-<data>.sql
```

Os dumps **não** podem ficar no repositório — o `.gitignore` não cobre `.sql`
nem `.dump`. Ficam em `Documents/Projects/securo-dumps/`, fora da árvore.

### Restore por cima da produção (excepcional)

Só quando a mudança é grande demais para SQL pontual, e **só depois** de
atualizar o local a partir da produção — senão descarta o que foi feito na tela:

1. dump da produção como rede de segurança (`pg_dump > backup-pre-<motivo>.sql`)
2. parar `backend`, `celery-worker` e `celery-beat`
3. `psql -U postgres -d securo < dump.sql` (o `pg_dump` já sai com
   `--clean --if-exists`)
4. `up -d` com os três compose files

Um restore descarta o que a sincronização trouxer para a produção nesse
intervalo; lançamentos vindos do provider voltam sozinhos no próximo sync,
porque o pareamento é pela `external_id` — mas edição feita na tela (categoria,
ignorar, desparear) não volta.
